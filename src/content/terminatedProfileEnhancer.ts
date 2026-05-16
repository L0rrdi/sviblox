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

import { getRobloxUser, getCombinedNames, RobloxUser } from '@/api/users';
import {
  getUserAvatarHeadshots,
  getGroupIcons,
  getAssetThumbnails,
  getGameIcons,
  getBadgeIcons,
} from '@/api/thumbnails';
import { robloxFetch } from '@/api/robloxClient';
import { getFavoriteGames, FavoriteGame } from '@/api/favorites';
import { getGameInfo } from '@/api/games';

const STYLE_ID = 'bloxplus-banned-profile-style';
const ROOT_ID = 'bloxplus-banned-profile';
const SESSION_KEY = 'bp.lastProfileNav';
const CLICK_FLAG = '__bpBannedClickInstalled';
const OBSERVER_FLAG = '__bpBannedObserverInstalled';
const STALE_MS = 30_000;

let renderedForUserId: number | null = null;
let inflight = false;

export async function run(): Promise<void> {
  installClickInterceptOnce();
  installFriendCardObserverOnce();
  repairDeletedFriendCards();

  const directMatch = location.pathname.match(/^\/users\/(\d+)\/profile/);
  if (directMatch) {
    const userId = Number(directMatch[1]);
    if (Number.isFinite(userId)) {
      stashProfileNav(userId);
      await maybeRender(userId);
    }
    return;
  }

  if (location.pathname === '/request-error') {
    const recovered = readRecentProfileNav();
    if (recovered) await maybeRender(recovered);
    return;
  }

  // Left a profile context — clear local state so future visits re-render.
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
    if (li.dataset.bpRepaired) continue;
    if (!/^\d+$/.test(li.id)) continue;
    const container = li.querySelector<HTMLElement>('.avatar-card-container');
    if (!container?.classList.contains('disabled')) continue;
    if (li.querySelector('a.bp-banned-card-overlay')) continue;
    li.dataset.bpRepaired = '1';

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
  obs.observe(document.documentElement, { childList: true, subtree: true });
}

function installClickInterceptOnce(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w[CLICK_FLAG]) return;
  w[CLICK_FLAG] = true;
  document.addEventListener(
    'click',
    (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href*="/users/"]');
      if (!a) return;
      const href = a.getAttribute('href') ?? '';
      const m = href.match(/\/users\/(\d+)\/profile/);
      if (!m) return;
      const id = Number(m[1]);
      if (Number.isFinite(id)) stashProfileNav(id);
    },
    true
  );
}

function stashProfileNav(userId: number): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id: userId, ts: Date.now() }));
  } catch {
    /* private mode etc. */
  }
}

function readRecentProfileNav(): number | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const { id, ts } = JSON.parse(raw) as { id?: number; ts?: number };
    if (typeof id !== 'number' || typeof ts !== 'number') return null;
    if (Date.now() - ts > STALE_MS) return null;
    return id;
  } catch {
    return null;
  }
}

async function maybeRender(userId: number): Promise<void> {
  if (renderedForUserId === userId && document.getElementById(ROOT_ID)) return;
  if (inflight) return;
  inflight = true;
  try {
    let user = await getRobloxUser(userId);

    // Forgotten accounts can return 404 from the v1 endpoint. Fall back
    // to the combined-names API so we still have *some* identity to show.
    if (!user) {
      const combined = await getCombinedNames([userId]);
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
    await render(user);
  } finally {
    inflight = false;
  }
}

// ---------- Render ----------

async function render(user: RobloxUser): Promise<void> {
  ensureStyle();

  // Wait for #content to mount; Roblox renders it as part of the SPA shell.
  const content = await waitFor<HTMLElement>(() => document.getElementById('content'));
  if (!content) return;

  document.title = `${user.displayName} (@${user.name}) - Roblox`;

  // Replace whatever Roblox put in #content (the 404 page or partial profile).
  content.innerHTML = '';
  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.dataset.bpUserId = String(user.id);
  content.appendChild(root);

  root.appendChild(buildHeader(user));
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
  const creationsHost = section(creationsPane, 'Experiences');

  // Fan out the data loads. Each is independent and self-hides on empty.
  void loadStats(user.id, root);
  void loadAvatar(user.id, root);
  void loadCurrentlyWearing(user.id, wearingHost);
  void loadFavorites(user.id, favoritesHost);
  void loadFriends(user.id, friendsHost);
  void loadGroups(user.id, groupsHost);
  void loadBadges(user.id, badgesHost);
  void loadCreations(user.id, creationsHost);
}

// ---------- Header ----------

function buildHeader(user: RobloxUser): HTMLElement {
  const header = el('div', { class: 'bp-banned-header' });

  const avatarBox = el('div', { class: 'bp-banned-avatar', id: 'bp-banned-avatar' });
  avatarBox.appendChild(el('div', { class: 'bp-banned-avatar-skeleton' }));
  header.appendChild(avatarBox);

  const meta = el('div', { class: 'bp-banned-meta' });
  const nameRow = el('div', { class: 'bp-banned-name-row' });
  nameRow.appendChild(text('h1', user.displayName, 'bp-banned-display-name'));
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
    const tile = el('a', { class: 'bp-tile', href: `/catalog/${id}/-` });
    tile.appendChild(thumbImg(thumbs.get(id), 'asset'));
    host.appendChild(tile);
    grid.appendChild(tile);
  }
  host.appendChild(grid);
  revealSection(host);
}

async function loadFavorites(userId: number, host: HTMLElement): Promise<void> {
  let games: FavoriteGame[];
  try {
    games = (await getFavoriteGames(userId, 10)).slice(0, 6);
  } catch {
    return;
  }
  if (!games.length) return;
  const universeIds = games.map((g) => g.id);
  const [icons, info] = await Promise.all([
    getGameIcons(universeIds),
    getGameInfo(universeIds).catch(() => new Map()),
  ]);
  const carousel = el('div', { class: 'bp-carousel' });
  for (const g of games) {
    const card = el('a', {
      class: 'bp-game-card',
      href: g.rootPlace?.id ? `/games/${g.rootPlace.id}/-` : `/games/?GameID=${g.id}`,
    });
    card.appendChild(thumbImg(icons.get(g.id), 'game'));
    const meta = el('div', { class: 'bp-game-meta' });
    meta.appendChild(text('div', g.name, 'bp-game-name'));
    const playing = info.get(g.id)?.playing;
    if (typeof playing === 'number') {
      meta.appendChild(text('div', `${formatCount(playing)} active`, 'bp-game-sub'));
    }
    card.appendChild(meta);
    carousel.appendChild(card);
  }
  host.appendChild(carousel);
  revealSection(host);
}

interface FriendItem {
  id: number;
  name?: string;
  displayName?: string;
}

async function loadFriends(userId: number, host: HTMLElement): Promise<void> {
  let items: FriendItem[];
  try {
    const r = await robloxFetch<{ PageItems?: FriendItem[] }>(
      `https://friends.roblox.com/v1/users/${userId}/friends/find?userSort=2&limit=18`,
      { cacheTtlMs: 5 * 60_000, retries: 1 }
    );
    items = (r.PageItems ?? []).filter((f) => f.id > 0);
  } catch {
    return;
  }
  if (!items.length) return;
  const ids = items.map((f) => f.id);
  const [headshots, names] = await Promise.all([
    getUserAvatarHeadshots(ids),
    getCombinedNames(ids),
  ]);
  const carousel = el('div', { class: 'bp-carousel' });
  for (const f of items) {
    const profile = names.get(f.id);
    const display = profile?.names?.combinedName ?? f.displayName ?? f.name ?? `User ${f.id}`;
    const username = profile?.names?.username ?? f.name ?? '';
    const tile = el('a', { class: 'bp-friend-tile', href: `/users/${f.id}/profile` });
    tile.appendChild(thumbImg(headshots.get(f.id), 'avatar'));
    tile.appendChild(text('div', display, 'bp-friend-display'));
    if (username) tile.appendChild(text('div', `@${username}`, 'bp-friend-username'));
    carousel.appendChild(tile);
  }
  host.appendChild(carousel);
  revealSection(host);
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

async function loadBadges(userId: number, host: HTMLElement): Promise<void> {
  let rows: BadgeRow[];
  try {
    const r = await robloxFetch<{ data?: BadgeRow[] }>(
      `https://badges.roblox.com/v1/users/${userId}/badges?limit=10&sortOrder=Desc`,
      { cacheTtlMs: 5 * 60_000, retries: 1 }
    );
    rows = (r.data ?? []).slice(0, 8);
  } catch {
    return;
  }
  if (!rows.length) return;
  const icons = await getBadgeIcons(rows.map((b) => b.id));
  const carousel = el('div', { class: 'bp-carousel' });
  for (const b of rows) {
    const card = el('a', { class: 'bp-badge-card', href: `/badges/${b.id}/-` });
    card.appendChild(thumbImg(icons.get(b.id), 'badge'));
    card.appendChild(text('div', b.name, 'bp-badge-name'));
    carousel.appendChild(card);
  }
  host.appendChild(carousel);
  revealSection(host);
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
    .bp-tile, .bp-friend-tile, .bp-game-card, .bp-group-card, .bp-badge-card {
      display: flex; flex-direction: column; gap: 6px;
      flex: 0 0 auto; width: 150px;
      color: inherit; text-decoration: none;
      padding: 4px;
      border-radius: 8px;
    }
    .bp-grid .bp-tile, .bp-grid .bp-game-card { width: auto; }
    .bp-tile:hover, .bp-friend-tile:hover, .bp-game-card:hover, .bp-group-card:hover, .bp-badge-card:hover {
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
