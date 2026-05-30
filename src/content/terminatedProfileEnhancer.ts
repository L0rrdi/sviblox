/**
 * SviBlox banned/terminated profile viewer.
 *
 * Roblox 302-redirects banned profile URLs (e.g. /users/6/profile) to
 * /request-error?code=404, dropping the userId. Two recovery paths:
 *
 * 1. Click intercept: any in-page click on an `/users/{id}/profile` link
 *    stashes that id in sessionStorage so we can recover it after the
 *    redirect lands on /request-error.
 * 2. Direct profile load: when the profile route still resolves (some
 *    banned states render the normal profile shell), pre-check the v1
 *    user endpoint and overlay if isBanned.
 *
 * The overlay replaces #content with a SviBlox-rendered profile.
 */

import { getRobloxUser, getCombinedNames, CombinedNamesEntry, RobloxUser } from '@/api/users';
import { getSettings } from '@/storage/settingsStore';
import { ensureAnnotationsPrimed, getNickname } from '@/storage/profileAnnotations';
import {
  getUserAvatarHeadshots,
  getGroupIcons,
  getAssetThumbnails,
  getGameIcons,
  getBadgeIcons,
} from '@/api/thumbnails';
import { robloxFetch } from '@/api/robloxClient';
import { getAllFavoriteGames, FavoriteGame } from '@/api/favorites';
import { getGameInfo } from '@/api/games';
import { getAllUserBadges } from '@/api/badges';
import { getMyFriends } from '@/api/friends';
import {
  getCollectiblesValue,
  getAvatarItemsValue,
  CollectiblesValue,
  AvatarItemsValue,
} from '@/api/accountValue';

import { install as installBannedTrap, readRecentProfileNav } from './bannedProfileTrap';

const STYLE_ID = 'bloxplus-banned-profile-style';
const ROOT_ID = 'bloxplus-banned-profile';
const OBSERVER_FLAG = '__bpBannedObserverInstalled';

let renderedForUserId: number | null = null;
let loadingKey: string | null = null;
let loadSeq = 0;

export async function run(): Promise<void> {
  installBannedTrap(); // idempotent; router also installs it as always-on.
  installFriendCardObserverOnce();
  repairDeletedFriendCards();

  const directMatch = location.pathname.match(/^\/users\/(\d+)\/profile/);
  if (directMatch) {
    const userId = Number(directMatch[1]);
    if (Number.isFinite(userId)) {
      await maybeRender(userId, location.pathname);
    }
    return;
  }

  if (location.pathname === '/request-error') {
    const recovered = readRecentProfileNav();
    if (recovered) await maybeRender(recovered, location.pathname);
    return;
  }

  // Left a profile context — clear local state so future visits re-render.
  loadSeq += 1;
  loadingKey = null;
  if (renderedForUserId !== null) {
    renderedForUserId = null;
    document.getElementById(ROOT_ID)?.remove();
  }
}

/**
 * Roblox strips the `<a href="/users/{id}/profile">` from "Account Deleted"
 * friend cards but leaves the userId on `<li id="{userId}">`. Cover the
 * entire card with a stretched anchor so a click anywhere on the tile —
 * not just the avatar/name link area — navigates to the profile and our
 * recovery path renders.
 */
function repairDeletedFriendCards(): void {
  const cards = document.querySelectorAll<HTMLLIElement>(
    'li.avatar-card.list-item[id]'
  );
  for (const li of cards) {
    const repairedFor = li.dataset.bpRepaired;
    if (repairedFor && repairedFor !== li.id) {
      li.querySelector('a.bp-banned-card-overlay')?.remove();
      delete li.dataset.bpRepaired;
    }
    if (!/^\d+$/.test(li.id)) {
      li.querySelector('a.bp-banned-card-overlay')?.remove();
      delete li.dataset.bpRepaired;
      continue;
    }
    const container = li.querySelector<HTMLElement>('.avatar-card-container');
    if (!container?.classList.contains('disabled')) {
      li.querySelector('a.bp-banned-card-overlay')?.remove();
      delete li.dataset.bpRepaired;
      continue;
    }
    if (li.dataset.bpRepaired === li.id) continue;
    if (li.querySelector('a.bp-banned-card-overlay')) continue;
    li.dataset.bpRepaired = li.id;

    if (getComputedStyle(li).position === 'static') li.style.position = 'relative';
    li.style.cursor = 'pointer';

    const overlay = document.createElement('a');
    overlay.className = 'bp-banned-card-overlay';
    overlay.href = `/users/${li.id}/profile`;
    overlay.title = 'View banned profile (SviBlox)';
    overlay.style.cssText =
      'position:absolute; inset:0; z-index:10; display:block; ' +
      'background:transparent; text-decoration:none; cursor:pointer;';
    li.appendChild(overlay);
  }
}

/**
 * The friends list mounts after our route-change dispatch fires, so a
 * single repair pass misses everything. Watch the document for new
 * avatar-card list items and repair as they appear. Coalesced so one
 * observer instance survives multiple dispatch() calls.
 */
function installFriendCardObserverOnce(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w[OBSERVER_FLAG]) return;
  w[OBSERVER_FLAG] = true;
  let scheduled = false;
  const obs = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      repairDeletedFriendCards();
    });
  });
  obs.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['id', 'class'],
  });
}

async function maybeRender(userId: number, path: string): Promise<void> {
  if (renderedForUserId === userId && document.getElementById(ROOT_ID)) return;
  const key = `${path}:${userId}`;
  if (loadingKey === key) return;
  loadingKey = key;
  const seq = ++loadSeq;
  try {
    let user = await getRobloxUser(userId);
    if (isStale(seq, path, userId)) return;

    // Forgotten accounts can return 404 from the v1 endpoint. Fall back
    // to the combined-names API so we still have *some* identity to show.
    if (!user) {
      const combined = await getCombinedNames([userId]);
      if (isStale(seq, path, userId)) return;
      const c = combined.get(userId);
      if (!c) return;
      user = {
        id: userId,
        name: c.names?.username ?? 'Account Forgotten',
        displayName: c.names?.combinedName ?? c.names?.username ?? 'Account Forgotten',
        description: '',
        created: '',
        isBanned: true,
        hasVerifiedBadge: c.isVerified ?? false,
      };
    }

    if (!user.isBanned) return;

    renderedForUserId = userId;
    await render(user, seq, path);
  } finally {
    if (loadingKey === key) loadingKey = null;
  }
}

function isStale(seq: number, path: string, userId: number): boolean {
  if (seq !== loadSeq || location.pathname !== path) return true;
  if (path === '/request-error') return readRecentProfileNav() !== userId;
  return readProfileUserId() !== userId;
}

function readProfileUserId(): number | null {
  const match = location.pathname.match(/^\/users\/(\d+)\/profile/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) ? id : null;
}

// ---------- Render ----------

async function render(user: RobloxUser, seq: number, path: string): Promise<void> {
  ensureStyle();

  // Prime profile annotations + read the toggle so the header can append the
  // private nickname (if any) right next to the displayName.
  const settings = await getSettings();
  if (isStale(seq, path, user.id)) return;
  if (settings.showProfileNotes) await ensureAnnotationsPrimed();
  if (isStale(seq, path, user.id)) return;

  // Wait for #content to mount; Roblox renders it as part of the SPA shell.
  const content = await waitFor<HTMLElement>(() => document.getElementById('content'));
  if (isStale(seq, path, user.id)) return;
  if (!content) return;

  document.title = `${user.displayName} (@${user.name}) - Roblox`;

  // Replace whatever Roblox put in #content (the 404 page or partial profile).
  content.innerHTML = '';
  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.dataset.bpUserId = String(user.id);
  content.appendChild(root);

  root.appendChild(buildHeader(user, Boolean(settings.showProfileNotes)));
  const tabsBar = buildTabsBar();
  root.appendChild(tabsBar);

  const aboutPane = el('div', { class: 'bp-tab-pane bp-tab-active', id: 'bp-pane-about' });
  const creationsPane = el('div', { class: 'bp-tab-pane', id: 'bp-pane-creations' });
  root.appendChild(aboutPane);
  root.appendChild(creationsPane);

  bindTabs(tabsBar, [
    { tabId: 'about', pane: aboutPane },
    { tabId: 'creations', pane: creationsPane },
  ]);

  // Section placeholders (rendered immediately for layout, populated async).
  const wearingHost = section(aboutPane, 'Currently wearing');
  const favoritesHost = section(aboutPane, 'Favorite experiences');
  const friendsHost = section(aboutPane, 'Friends');
  const groupsHost = section(aboutPane, 'Communities');
  const badgesHost = section(aboutPane, 'Badges');
  const accountValueHost = section(aboutPane, 'Account value');
  const creationsHost = section(creationsPane, 'Experiences');

  // Fan out the data loads. Each is independent and self-hides on empty.
  void loadStats(user.id, root);
  void loadAvatar(user.id, root);
  void loadCurrentlyWearing(user.id, wearingHost);
  void loadFavorites(user.id, favoritesHost);
  void loadFriends(user.id, friendsHost);
  void loadGroups(user.id, groupsHost);
  void loadBadges(user.id, badgesHost);
  void loadAccountValue(user.id, accountValueHost, Boolean(settings.showAccountValue));
  void loadCreations(user.id, creationsHost);
}

// ---------- Header ----------

function buildHeader(user: RobloxUser, showNickname: boolean): HTMLElement {
  const header = el('div', { class: 'bp-banned-header' });

  const avatarBox = el('div', { class: 'bp-banned-avatar', id: 'bp-banned-avatar' });
  avatarBox.appendChild(el('div', { class: 'bp-banned-avatar-skeleton' }));
  header.appendChild(avatarBox);

  const meta = el('div', { class: 'bp-banned-meta' });
  const nameRow = el('div', { class: 'bp-banned-name-row' });
  nameRow.appendChild(text('h1', user.displayName, 'bp-banned-display-name'));
  const nickname = showNickname ? getNickname(user.id) : null;
  if (nickname) {
    nameRow.appendChild(text('span', `(${nickname})`, 'bp-banned-nickname'));
  }
  if (user.hasVerifiedBadge) nameRow.appendChild(verifiedBadge());
  nameRow.appendChild(bannedBadge());
  meta.appendChild(nameRow);

  meta.appendChild(text('div', `@${user.name}`, 'bp-banned-username'));

  const stats = el('div', { class: 'bp-banned-stats', id: 'bp-banned-stats' });
  stats.appendChild(statPill('bp-stat-friends', 'Friends', `/users/${user.id}/friends#!/friends`));
  stats.appendChild(statPill('bp-stat-followers', 'Followers', `/users/${user.id}/friends#!/followers`));
  stats.appendChild(statPill('bp-stat-following', 'Following', `/users/${user.id}/friends#!/following`));
  meta.appendChild(stats);

  if (user.description) {
    meta.appendChild(text('p', user.description, 'bp-banned-description'));
  }
  if (user.created) {
    const joined = new Date(user.created);
    if (!Number.isNaN(joined.getTime())) {
      meta.appendChild(
        text('div', `Joined ${joined.toLocaleDateString()}`, 'bp-banned-joined')
      );
    }
  }

  header.appendChild(meta);
  return header;
}

function bannedBadge(): HTMLElement {
  const span = el('span', { class: 'bp-banned-badge', title: 'Account permanently banned' });
  span.textContent = 'BANNED';
  return span;
}

function verifiedBadge(): HTMLElement {
  const span = el('span', { class: 'bp-verified-badge', title: 'Verified' });
  span.textContent = '✓';
  return span;
}

function statPill(id: string, label: string, href: string): HTMLElement {
  const a = el('a', { class: 'bp-stat-pill', href }) as HTMLAnchorElement;
  const valueEl = el('span', { class: 'bp-stat-value bp-shimmer', id });
  valueEl.textContent = '—';
  const labelEl = el('span', { class: 'bp-stat-label' });
  labelEl.textContent = label;
  a.appendChild(valueEl);
  a.appendChild(labelEl);
  return a;
}

// ---------- Tabs ----------

function buildTabsBar(): HTMLElement {
  const ul = el('ul', { class: 'bp-tabs' });
  ul.appendChild(tabLink('about', 'About', true));
  ul.appendChild(tabLink('creations', 'Creations', false));
  return ul;
}

function tabLink(tabId: string, label: string, active: boolean): HTMLElement {
  const li = el('li', { class: 'bp-tab' + (active ? ' bp-tab-active' : '') });
  const a = el('a', { class: 'bp-tab-link', 'data-bp-tab': tabId, href: '#' });
  a.textContent = label;
  li.appendChild(a);
  return li;
}

function bindTabs(bar: HTMLElement, tabs: Array<{ tabId: string; pane: HTMLElement }>): void {
  bar.addEventListener('click', (e) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>('a[data-bp-tab]');
    if (!a) return;
    e.preventDefault();
    const target = a.dataset.bpTab;
    bar.querySelectorAll('.bp-tab').forEach((li) => li.classList.remove('bp-tab-active'));
    a.parentElement?.classList.add('bp-tab-active');
    tabs.forEach(({ tabId, pane }) => {
      pane.classList.toggle('bp-tab-active', tabId === target);
    });
  });
}

// ---------- Sections ----------

function section(parent: HTMLElement, title: string): HTMLElement {
  const wrap = el('section', { class: 'bp-section', 'data-bp-empty': '1' });
  wrap.appendChild(text('h2', title, 'bp-section-title'));
  const body = el('div', { class: 'bp-section-body' });
  wrap.appendChild(body);
  parent.appendChild(wrap);
  return body;
}

function revealSection(host: HTMLElement): void {
  host.parentElement?.removeAttribute('data-bp-empty');
}

// ---------- Loaders ----------

async function loadStats(userId: number, root: HTMLElement): Promise<void> {
  const fields: Array<['bp-stat-friends' | 'bp-stat-followers' | 'bp-stat-following', string]> = [
    ['bp-stat-friends', `https://friends.roblox.com/v1/users/${userId}/friends/count`],
    ['bp-stat-followers', `https://friends.roblox.com/v1/users/${userId}/followers/count`],
    ['bp-stat-following', `https://friends.roblox.com/v1/users/${userId}/followings/count`],
  ];
  const results = await Promise.all(
    fields.map(([, url]) =>
      robloxFetch<{ count: number }>(url, { cacheTtlMs: 5 * 60_000, retries: 1 }).catch(
        () => ({ count: 0 })
      )
    )
  );
  fields.forEach(([id], i) => {
    const elv = root.querySelector<HTMLElement>(`#${id}`);
    if (!elv) return;
    elv.classList.remove('bp-shimmer');
    elv.textContent = (results[i]?.count ?? 0).toLocaleString();
  });
}

async function loadAvatar(userId: number, root: HTMLElement): Promise<void> {
  // Banned users come back with state: "Blocked" but the imageUrl is still
  // a usable placeholder, so accept any state that has a URL.
  let url: string | undefined;
  try {
    const data = await robloxFetch<{
      data?: Array<{ targetId: number; state: string; imageUrl: string }>;
    }>(
      `https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}` +
        `&size=420x420&format=Png&isCircular=false`,
      { cacheKey: `bannedAvatar:${userId}`, cacheTtlMs: 24 * 60 * 60_000, retries: 1 }
    );
    url = data.data?.find((d) => d.targetId === userId)?.imageUrl;
  } catch {
    /* fall through to broken */
  }
  const box = root.querySelector<HTMLElement>('#bp-banned-avatar');
  if (!box) return;
  box.innerHTML = '';
  if (url) {
    const img = el('img', {
      class: 'bp-banned-avatar-img',
      src: url,
      alt: '',
      loading: 'lazy',
    }) as HTMLImageElement;
    img.addEventListener(
      'error',
      () => {
        box.innerHTML = '';
        box.appendChild(brokenAvatar());
      },
      { once: true }
    );
    box.appendChild(img);
  } else {
    box.appendChild(brokenAvatar());
  }
}

function brokenAvatar(): HTMLElement {
  const el2 = el('div', { class: 'bp-banned-avatar-broken' });
  el2.textContent = '?';
  return el2;
}

async function loadCurrentlyWearing(userId: number, host: HTMLElement): Promise<void> {
  let assetIds: number[] = [];
  try {
    const data = await robloxFetch<{ assetIds?: number[] }>(
      `https://avatar.roblox.com/v1/users/${userId}/currently-wearing`,
      { cacheTtlMs: 5 * 60_000, retries: 1 }
    );
    assetIds = data.assetIds ?? [];
  } catch {
    return;
  }
  if (!assetIds.length) return;
  const thumbs = await getAssetThumbnails(assetIds);
  const grid = el('div', { class: 'bp-grid' });
  for (const id of assetIds) {
    const tile = el('a', { class: 'bp-term-tile', href: `/catalog/${id}/-` });
    tile.appendChild(thumbImg(thumbs.get(id), 'asset'));
    grid.appendChild(tile);
  }
  host.appendChild(grid);
  revealSection(host);
}

const FAVORITES_VISIBLE = 6;

async function loadFavorites(userId: number, host: HTMLElement): Promise<void> {
  let games: FavoriteGame[];
  try {
    games = await getAllFavoriteGames(userId);
  } catch {
    return;
  }
  if (!games.length) return;

  const initial = games.slice(0, FAVORITES_VISIBLE);
  const initialIds = initial.map((g) => g.id);
  const [icons, info] = await Promise.all([
    getGameIcons(initialIds),
    getGameInfo(initialIds).catch(() => new Map()),
  ]);

  const carousel = el('div', { class: 'bp-carousel' });
  for (const g of initial) {
    carousel.appendChild(renderFavoriteCard(g, icons.get(g.id), info.get(g.id)?.playing));
  }
  host.appendChild(carousel);

  if (games.length > FAVORITES_VISIBLE) {
    const more = el('button', { type: 'button', class: 'bp-show-all-btn' });
    more.textContent = `Show all ${formatCount(games.length)} favorites →`;
    more.addEventListener('click', async () => {
      (more as HTMLButtonElement).disabled = true;
      more.textContent = 'Loading…';
      const allIds = games.map((g) => g.id);
      const [allIcons, allInfo] = await Promise.all([
        getGameIcons(allIds),
        getGameInfo(allIds).catch(() => new Map()),
      ]);
      const grid = el('div', { class: 'bp-grid' });
      for (const g of games) {
        grid.appendChild(renderFavoriteCard(g, allIcons.get(g.id), allInfo.get(g.id)?.playing));
      }
      carousel.replaceWith(grid);
      more.remove();
    });
    host.appendChild(more);
  }
  revealSection(host);
}

function renderFavoriteCard(
  g: FavoriteGame,
  icon: string | undefined,
  playing: number | undefined
): HTMLElement {
  const card = el('a', {
    class: 'bp-game-card',
    href: g.rootPlace?.id ? `/games/${g.rootPlace.id}/-` : `/games/?GameID=${g.id}`,
  });
  card.appendChild(thumbImg(icon, 'game'));
  const meta = el('div', { class: 'bp-game-meta' });
  meta.appendChild(text('div', g.name, 'bp-game-name'));
  if (typeof playing === 'number') {
    meta.appendChild(text('div', `${formatCount(playing)} active`, 'bp-game-sub'));
  }
  card.appendChild(meta);
  return card;
}

interface FriendItem {
  id: number;
  name?: string;
  displayName?: string;
}

const FRIENDS_VISIBLE = 18;

async function loadFriends(userId: number, host: HTMLElement): Promise<void> {
  let items: FriendItem[];
  try {
    // `/v1/users/{id}/friends` returns the full friend list in a single
    // call (no pagination), unlike `/friends/find` which we used before.
    items = (await getMyFriends(userId)).filter((f) => f.id > 0);
  } catch {
    return;
  }
  if (!items.length) return;

  const initial = items.slice(0, FRIENDS_VISIBLE);
  const initialIds = initial.map((f) => f.id);
  const [headshots, names] = await Promise.all([
    getUserAvatarHeadshots(initialIds),
    getCombinedNames(initialIds),
  ]);

  const carousel = el('div', { class: 'bp-carousel' });
  for (const f of initial) {
    carousel.appendChild(renderFriendTile(f, headshots.get(f.id), names.get(f.id)));
  }
  host.appendChild(carousel);

  if (items.length > FRIENDS_VISIBLE) {
    const more = el('button', { type: 'button', class: 'bp-show-all-btn' });
    more.textContent = `Show all ${formatCount(items.length)} friends →`;
    more.addEventListener('click', async () => {
      (more as HTMLButtonElement).disabled = true;
      more.textContent = 'Loading…';
      const allIds = items.map((f) => f.id);
      const [allHeadshots, allNames] = await Promise.all([
        getUserAvatarHeadshots(allIds),
        getCombinedNames(allIds),
      ]);
      const grid = el('div', { class: 'bp-grid' });
      for (const f of items) {
        grid.appendChild(renderFriendTile(f, allHeadshots.get(f.id), allNames.get(f.id)));
      }
      carousel.replaceWith(grid);
      more.remove();
    });
    host.appendChild(more);
  }
  revealSection(host);
}

function renderFriendTile(
  f: FriendItem,
  headshot: string | undefined,
  profile: CombinedNamesEntry | undefined
): HTMLElement {
  const display = profile?.names?.combinedName ?? f.displayName ?? f.name ?? `User ${f.id}`;
  const username = profile?.names?.username ?? f.name ?? '';
  const tile = el('a', { class: 'bp-friend-tile', href: `/users/${f.id}/profile` });
  tile.appendChild(thumbImg(headshot, 'avatar'));
  tile.appendChild(text('div', display, 'bp-friend-display'));
  if (username) tile.appendChild(text('div', `@${username}`, 'bp-friend-username'));
  return tile;
}

interface GroupRow {
  group: { id: number; name: string; memberCount?: number; hasVerifiedBadge?: boolean };
  role: { name: string };
}

async function loadGroups(userId: number, host: HTMLElement): Promise<void> {
  let rows: GroupRow[];
  try {
    const r = await robloxFetch<{ data?: GroupRow[] }>(
      `https://groups.roblox.com/v1/users/${userId}/groups/roles?includeLocked=true`,
      { cacheTtlMs: 10 * 60_000, retries: 1 }
    );
    rows = r.data ?? [];
  } catch {
    return;
  }
  if (!rows.length) return;
  const icons = await getGroupIcons(rows.map((r) => r.group.id));
  const carousel = el('div', { class: 'bp-carousel' });
  for (const row of rows) {
    const card = el('a', { class: 'bp-group-card', href: `/communities/${row.group.id}/-` });
    card.appendChild(thumbImg(icons.get(row.group.id), 'group'));
    card.appendChild(text('div', row.group.name, 'bp-group-name'));
    if (typeof row.group.memberCount === 'number') {
      card.appendChild(
        text('div', `${formatCount(row.group.memberCount)} members`, 'bp-group-sub')
      );
    }
    card.appendChild(text('div', row.role.name, 'bp-group-role'));
    carousel.appendChild(card);
  }
  host.appendChild(carousel);
  revealSection(host);
}

interface BadgeRow {
  id: number;
  name: string;
}

const BADGES_VISIBLE = 8;

async function loadBadges(userId: number, host: HTMLElement): Promise<void> {
  let rows: BadgeRow[];
  try {
    rows = (await getAllUserBadges(userId)) as BadgeRow[];
  } catch {
    return;
  }
  if (!rows.length) return;

  const initial = rows.slice(0, BADGES_VISIBLE);
  const initialIcons = await getBadgeIcons(initial.map((b) => b.id));

  const carousel = el('div', { class: 'bp-carousel' });
  for (const b of initial) {
    carousel.appendChild(renderBadgeCard(b, initialIcons.get(b.id)));
  }
  host.appendChild(carousel);

  if (rows.length > BADGES_VISIBLE) {
    const more = el('button', { type: 'button', class: 'bp-show-all-btn' });
    more.textContent = `Show all ${formatCount(rows.length)} badges →`;
    more.addEventListener('click', async () => {
      (more as HTMLButtonElement).disabled = true;
      more.textContent = 'Loading…';
      const allIcons = await getBadgeIcons(rows.map((b) => b.id));
      const grid = el('div', { class: 'bp-grid' });
      for (const b of rows) {
        grid.appendChild(renderBadgeCard(b, allIcons.get(b.id)));
      }
      carousel.replaceWith(grid);
      more.remove();
    });
    host.appendChild(more);
  }
  revealSection(host);
}

function renderBadgeCard(b: BadgeRow, icon: string | undefined): HTMLElement {
  const card = el('a', { class: 'bp-badge-card', href: `/badges/${b.id}/-` });
  card.appendChild(thumbImg(icon, 'badge'));
  card.appendChild(text('div', b.name, 'bp-badge-name'));
  return card;
}

/**
 * Lazy "Calculate inventory value" entry. We don't fire the inventory walk
 * automatically because the avatar-items pagination can run up to ~10
 * sequential calls + a few catalog-details POSTs (~5-10s on a fat
 * inventory) — most banned-profile views won't care, so we gate it behind
 * an explicit click. Gated by the `showAccountValue` popup toggle.
 */
async function loadAccountValue(
  userId: number,
  host: HTMLElement,
  enabled: boolean
): Promise<void> {
  if (!enabled) return;

  const cta = el('button', { type: 'button', class: 'bp-account-value-cta' });
  cta.textContent = 'Calculate inventory value →';
  cta.title = 'Sums Limited RAP and current catalog prices of avatar items';
  host.appendChild(cta);
  revealSection(host);

  cta.addEventListener('click', async () => {
    (cta as HTMLButtonElement).disabled = true;
    cta.textContent = 'Calculating…';
    let collectibles: CollectiblesValue;
    let avatarItems: AvatarItemsValue;
    try {
      [collectibles, avatarItems] = await Promise.all([
        getCollectiblesValue(userId),
        getAvatarItemsValue(userId),
      ]);
    } catch (e) {
      cta.replaceWith(text('div', `Could not load value: ${(e as Error).message}`, 'bp-section-empty'));
      return;
    }

    if (collectibles.privateInventory && avatarItems.privateInventory) {
      cta.replaceWith(
        text('div', "This account's inventory is private.", 'bp-section-empty')
      );
      return;
    }

    const total = collectibles.totalRap + avatarItems.totalRobux;
    const card = el('div', { class: 'bp-account-value-card-banned' });
    card.appendChild(metricCard('Known total', robux(total), 'Limited RAP + avatar item prices'));
    card.appendChild(
      metricCard(
        'Limited RAP',
        robux(collectibles.totalRap),
        `${formatExact(collectibles.valuedCollectibleCount)} valued limiteds`
      )
    );
    card.appendChild(
      metricCard('Collectibles', formatExact(collectibles.collectibleCount), 'Limited inventory rows')
    );
    card.appendChild(
      metricCard(
        'Avatar items',
        robux(avatarItems.totalRobux),
        avatarItems.privateInventory
          ? 'Inventory private'
          : `${formatExact(avatarItems.valuedItemCount)} of ${formatExact(avatarItems.itemCount)} priced`
      )
    );

    const caveats: string[] = [];
    if (collectibles.truncated) {
      caveats.push(`Scanned ${formatExact(collectibles.scannedPages * 100)}+ collectible rows; very large inventories may be partial.`);
    }
    if (avatarItems.truncated) {
      caveats.push(`Capped at ${formatExact(avatarItems.scannedPages * 100)} avatar items.`);
    }

    cta.replaceWith(card);
    if (caveats.length) {
      const note = text('div', caveats.join(' '), 'bp-account-value-note');
      host.appendChild(note);
    }
  });
}

function metricCard(label: string, value: string, detail: string): HTMLElement {
  const wrap = el('div', { class: 'bp-account-value-metric' });
  wrap.appendChild(text('span', label, 'bp-account-value-metric-label'));
  wrap.appendChild(text('strong', value, 'bp-account-value-metric-value'));
  wrap.appendChild(text('small', detail, 'bp-account-value-metric-detail'));
  return wrap;
}

function robux(n: number): string {
  return `R$ ${formatExact(Math.round(n))}`;
}

function formatExact(n: number): string {
  return new Intl.NumberFormat().format(n);
}

interface CreationRow {
  id: number;
  name: string;
  rootPlace?: { id: number };
  playing?: number;
}

async function loadCreations(userId: number, host: HTMLElement): Promise<void> {
  let games: CreationRow[];
  try {
    const r = await robloxFetch<{ data?: CreationRow[] }>(
      `https://games.roblox.com/v2/users/${userId}/games?accessFilter=2&limit=50&sortOrder=Asc`,
      { cacheTtlMs: 5 * 60_000, retries: 1 }
    );
    games = r.data ?? [];
  } catch {
    return;
  }
  if (!games.length) {
    host.appendChild(text('p', 'No experiences.', 'bp-empty'));
    revealSection(host);
    return;
  }
  const icons = await getGameIcons(games.map((g) => g.id));
  const grid = el('div', { class: 'bp-grid bp-grid-wide' });
  for (const g of games) {
    const card = el('a', {
      class: 'bp-game-card',
      href: g.rootPlace?.id ? `/games/${g.rootPlace.id}/-` : `/games/?GameID=${g.id}`,
    });
    card.appendChild(thumbImg(icons.get(g.id), 'game'));
    card.appendChild(text('div', g.name, 'bp-game-name'));
    grid.appendChild(card);
  }
  host.appendChild(grid);
  revealSection(host);
}

// ---------- Helpers ----------

function el(tag: string, attrs: Record<string, string> = {}): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function text(tag: string, value: string, className?: string): HTMLElement {
  const e = el(tag, className ? { class: className } : {});
  e.textContent = value;
  return e;
}

function thumbImg(src: string | undefined, kind: 'avatar' | 'asset' | 'game' | 'group' | 'badge'): HTMLElement {
  const wrap = el('div', { class: `bp-thumb bp-thumb-${kind}` });
  if (src) {
    const img = el('img', { class: 'bp-thumb-img', src, alt: '', loading: 'lazy' });
    wrap.appendChild(img);
  } else {
    wrap.appendChild(el('div', { class: 'bp-thumb-fallback' }));
  }
  return wrap;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

async function waitFor<T extends Element>(probe: () => T | null, timeoutMs = 4000): Promise<T | null> {
  const found = probe();
  if (found) return found;
  return new Promise<T | null>((resolve) => {
    const start = Date.now();
    const obs = new MutationObserver(() => {
      const f = probe();
      if (f) {
        obs.disconnect();
        resolve(f);
      } else if (Date.now() - start > timeoutMs) {
        obs.disconnect();
        resolve(null);
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      obs.disconnect();
      resolve(probe());
    }, timeoutMs);
  });
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${ROOT_ID} {
      max-width: 1140px;
      margin: 24px auto;
      padding: 0 16px;
      color: inherit;
      font: 14px/1.4 inherit;
    }
    .bp-banned-header {
      display: flex; gap: 24px; align-items: flex-start;
      padding: 24px;
      border-radius: 12px;
      background: linear-gradient(135deg, rgba(255,80,80,0.10), rgba(120,40,160,0.10));
      border: 1px solid rgba(255,255,255,0.08);
    }
    .bp-banned-avatar {
      width: 160px; height: 200px; min-width: 160px;
      border-radius: 12px;
      background: rgba(0,0,0,0.25);
      display: flex; align-items: center; justify-content: center;
      overflow: hidden;
      position: relative;
    }
    .bp-banned-avatar-img { width: 100%; height: 100%; object-fit: contain; }
    .bp-banned-avatar-skeleton {
      width: 80%; height: 80%; border-radius: 8px;
      background: linear-gradient(110deg, rgba(255,255,255,0.06) 30%, rgba(255,255,255,0.14) 50%, rgba(255,255,255,0.06) 70%);
      background-size: 200% 100%;
      animation: bp-shimmer 1.6s linear infinite;
    }
    .bp-banned-avatar-broken {
      font: 700 48px/1 inherit;
      color: rgba(255,255,255,0.4);
    }
    .bp-banned-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
    .bp-banned-name-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .bp-banned-display-name { font: 700 28px/1.1 inherit; margin: 0; }
    .bp-banned-nickname {
      padding: 2px 10px;
      border-radius: 999px;
      background: rgba(116, 64, 234, 0.18);
      border: 1px solid rgba(116, 64, 234, 0.55);
      color: #c5b3ff;
      font: 600 13px/1.2 inherit;
    }
    .bp-banned-username { color: rgba(255,255,255,0.7); font-size: 14px; }
    .bp-banned-badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 6px;
      background: #c0392b;
      color: white;
      font: 700 11px/1.4 inherit;
      letter-spacing: 0.06em;
    }
    .bp-verified-badge {
      display: inline-flex; align-items: center; justify-content: center;
      width: 18px; height: 18px;
      border-radius: 50%;
      background: #4a90e2; color: white;
      font: 700 12px/1 inherit;
    }
    .bp-banned-stats { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
    .bp-stat-pill {
      display: inline-flex; align-items: baseline; gap: 6px;
      padding: 6px 12px;
      border-radius: 999px;
      background: rgba(255,255,255,0.08);
      color: inherit; text-decoration: none;
      font-size: 13px;
    }
    .bp-stat-pill:hover { background: rgba(255,255,255,0.14); }
    .bp-stat-value { font-weight: 700; }
    .bp-stat-label { color: rgba(255,255,255,0.7); }
    .bp-banned-description {
      margin: 8px 0 0;
      white-space: pre-wrap;
      word-break: break-word;
      color: rgba(255,255,255,0.85);
      max-height: 6em;
      overflow: auto;
    }
    .bp-banned-joined { color: rgba(255,255,255,0.6); font-size: 12px; }
    .bp-shimmer {
      display: inline-block;
      min-width: 24px;
      background: linear-gradient(110deg, rgba(255,255,255,0.06) 30%, rgba(255,255,255,0.14) 50%, rgba(255,255,255,0.06) 70%);
      background-size: 200% 100%;
      animation: bp-shimmer 1.6s linear infinite;
      color: transparent;
      border-radius: 4px;
    }
    @keyframes bp-shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    .bp-tabs {
      display: flex; gap: 0; list-style: none; padding: 0; margin: 24px 0 0;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .bp-tab { flex: 1; }
    .bp-tab-link {
      display: block; padding: 12px 16px;
      text-align: center;
      color: rgba(255,255,255,0.7);
      text-decoration: none;
      font-weight: 600;
      border-bottom: 2px solid transparent;
    }
    .bp-tab.bp-tab-active .bp-tab-link {
      color: white;
      border-bottom-color: #4a90e2;
    }
    .bp-tab-pane { display: none; padding-top: 16px; }
    .bp-tab-pane.bp-tab-active { display: block; }
    .bp-section { margin-top: 24px; }
    .bp-section[data-bp-empty] { display: none; }
    .bp-section-title { font: 700 18px/1.2 inherit; margin: 0 0 12px; }
    .bp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 12px; }
    .bp-grid-wide { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
    .bp-carousel {
      display: flex; gap: 12px; overflow-x: auto; padding-bottom: 8px;
      scrollbar-width: thin;
    }
    .bp-term-tile, .bp-friend-tile, .bp-game-card, .bp-group-card, .bp-badge-card {
      display: flex; flex-direction: column; gap: 6px;
      flex: 0 0 auto; width: 150px;
      color: inherit; text-decoration: none;
      padding: 4px;
      border-radius: 8px;
    }
    .bp-grid .bp-term-tile, .bp-grid .bp-game-card, .bp-grid .bp-badge-card,
    .bp-grid .bp-group-card, .bp-grid .bp-friend-tile { width: auto; }
    .bp-show-all-btn {
      display: block;
      margin-top: 10px;
      padding: 8px 14px;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 6px;
      background: rgba(255,255,255,0.05);
      color: inherit;
      font: 600 13px/1 inherit;
      cursor: pointer;
    }
    .bp-show-all-btn:hover:not(:disabled) {
      background: rgba(255,255,255,0.10);
      border-color: rgba(255,255,255,0.30);
    }
    .bp-section-empty {
      padding: 8px 0;
      font-size: 13px;
      color: rgba(255,255,255,0.55);
    }
    .bp-account-value-cta {
      display: inline-block;
      padding: 8px 14px;
      border: 1px solid rgba(116, 64, 234, 0.55);
      border-radius: 6px;
      background: rgba(116, 64, 234, 0.18);
      color: #c5b3ff;
      font: 600 13px/1 inherit;
      cursor: pointer;
    }
    .bp-account-value-cta:hover:not(:disabled) {
      background: rgba(116, 64, 234, 0.28);
      border-color: rgba(116, 64, 234, 0.75);
    }
    .bp-account-value-cta:disabled {
      opacity: 0.65;
      cursor: progress;
    }
    .bp-account-value-card-banned {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 8px;
    }
    .bp-account-value-metric {
      min-width: 0;
      padding: 10px;
      border-radius: 8px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.08);
    }
    .bp-account-value-metric-label {
      display: block;
      font-size: 11px;
      font-weight: 700;
      color: rgba(255,255,255,0.62);
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .bp-account-value-metric-value {
      display: block;
      margin: 3px 0;
      font-size: 18px;
      color: #fff;
      overflow-wrap: anywhere;
    }
    .bp-account-value-metric-detail {
      display: block;
      font-size: 11px;
      color: rgba(255,255,255,0.58);
    }
    .bp-account-value-note {
      margin-top: 8px;
      font-size: 11px;
      color: rgba(255,255,255,0.55);
    }
    .bp-show-all-btn:disabled {
      opacity: 0.65;
      cursor: progress;
    }
    .bp-term-tile:hover, .bp-friend-tile:hover, .bp-game-card:hover, .bp-group-card:hover, .bp-badge-card:hover {
      background: rgba(255,255,255,0.06);
    }
    .bp-thumb {
      width: 100%; aspect-ratio: 1 / 1;
      border-radius: 8px;
      background: rgba(255,255,255,0.06);
      overflow: hidden;
      display: block;
    }
    .bp-thumb-img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .bp-thumb-fallback { width: 100%; height: 100%; }
    .bp-friend-tile .bp-thumb { aspect-ratio: 3 / 4; background: #e6e8eb; }
    .bp-friend-display, .bp-game-name, .bp-group-name, .bp-badge-name {
      font-weight: 600; font-size: 13px;
      overflow: hidden; text-overflow: ellipsis;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    }
    .bp-friend-username, .bp-game-sub, .bp-group-sub, .bp-group-role {
      color: rgba(255,255,255,0.6); font-size: 12px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .bp-empty { color: rgba(255,255,255,0.5); }
    @media (max-width: 720px) {
      .bp-banned-header { flex-direction: column; align-items: center; text-align: center; }
      .bp-banned-stats { justify-content: center; }
    }
  `;
  document.head.appendChild(style);
}
