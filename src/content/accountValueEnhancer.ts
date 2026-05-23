import {
  getCollectiblesValue,
  getOwnPurchaseValue,
  getAvatarItemsValue,
  CollectiblesValue,
  OwnPurchaseValue,
  AvatarItemsValue,
} from '@/api/accountValue';
import { getAuthenticatedUserId } from '@/api/users';
import { getSettings } from '@/storage/settingsStore';
import { escapeHtml } from '@/util/html';

const ROOT_ID = 'bloxplus-account-value';
const STYLE_ID = 'bloxplus-account-value-style';

let renderedForUser: number | null = null;
let renderedForPath: string | null = null;
let loadedForUser: number | null = null;
let loadedForPath: string | null = null;
let inflightForUser: number | null = null;

export async function run(): Promise<void> {
  const userId = readProfileUserId();
  if (!userId) {
    cleanup();
    return;
  }

  const settings = await getSettings();
  if (!settings.showAccountValue) {
    cleanup();
    return;
  }

  ensureStyle();
  const root = ensureRoot();
  if (!root) return;

  if (renderedForUser === userId && renderedForPath === location.pathname) {
    reattachIfMissing(root);
    return;
  }
  renderCollapsed(root, userId);
  renderedForUser = userId;
  renderedForPath = location.pathname;
}

async function loadValue(root: HTMLElement, userId: number): Promise<void> {
  if (loadedForUser === userId && loadedForPath === location.pathname) {
    setExpanded(root, true);
    return;
  }
  if (inflightForUser === userId) return;
  inflightForUser = userId;

  renderLoading(root, userId);

  try {
    const me = await getAuthenticatedUserId();
    const isOwnProfile = me === userId;
    const [collectibles, purchases, avatarItems] = await Promise.all([
      getCollectiblesValue(userId),
      isOwnProfile ? getOwnPurchaseValue(userId) : Promise.resolve(null),
      getAvatarItemsValue(userId),
    ]);
    renderValue(root, userId, collectibles, purchases, avatarItems, isOwnProfile);
    loadedForUser = userId;
    loadedForPath = location.pathname;
  } catch (e) {
    renderError(root, userId, (e as Error)?.message ?? 'Could not load account value.');
  } finally {
    inflightForUser = null;
  }
}

function cleanup(): void {
  document.getElementById(ROOT_ID)?.remove();
  renderedForUser = null;
  renderedForPath = null;
  loadedForUser = null;
  loadedForPath = null;
}

function reattachIfMissing(root: HTMLElement): void {
  const anchor = findAnchor();
  if (anchor && root.parentElement !== anchor.parentElement) {
    anchor.insertAdjacentElement('afterend', root);
  }
}

function ensureRoot(): HTMLElement | null {
  let root = document.getElementById(ROOT_ID);
  const anchor = findAnchor();
  if (!anchor) return root;
  if (!root) {
    root = document.createElement('section');
    root.id = ROOT_ID;
    root.className = 'bp-account-value-card';
  }
  if (root.parentElement !== anchor.parentElement || root.previousElementSibling !== anchor) {
    anchor.insertAdjacentElement('afterend', root);
  }
  return root;
}

function findAnchor(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('.profile-header') ??
    document.querySelector<HTMLElement>('[class*="profile-header"]') ??
    document.querySelector<HTMLElement>('#profile-about') ??
    document.querySelector<HTMLElement>('.profile-about') ??
    document.querySelector<HTMLElement>('#content')
  );
}

function renderCollapsed(root: HTMLElement, userId: number): void {
  renderFrame(
    root,
    userId,
    false,
    'Estimate limited RAP and known purchase spend.',
    ''
  );
}

function renderLoading(root: HTMLElement, userId: number): void {
  renderFrame(
    root,
    userId,
    true,
    'Scanning accessible inventory...',
    `
    <div class="bp-account-value-skeleton"></div>
  `
  );
}

function renderError(root: HTMLElement, userId: number, message: string): void {
  renderFrame(root, userId, true, message, '');
}

function renderValue(
  root: HTMLElement,
  userId: number,
  collectibles: CollectiblesValue,
  purchases: OwnPurchaseValue | null,
  avatarItems: AvatarItemsValue,
  isOwnProfile: boolean
): void {
  if (collectibles.privateInventory && avatarItems.privateInventory) {
    renderFrame(
      root,
      userId,
      true,
      'This inventory is private, so SviBlox cannot estimate value.',
      ''
    );
    return;
  }

  const knownTotal =
    collectibles.totalRap + (purchases?.totalRobuxSpent ?? 0) + avatarItems.totalRobux;
  const totalBreakdown = ['Limited RAP'];
  if (purchases) totalBreakdown.push('purchase spend');
  if (avatarItems.totalRobux > 0) totalBreakdown.push('avatar item prices');
  const totalDetail = totalBreakdown.join(' + ');

  const rows = [
    metric('Known total', robux(knownTotal), totalDetail),
    metric('Limited RAP', robux(collectibles.totalRap), `${collectibles.valuedCollectibleCount} valued limiteds`),
    metric('Collectibles', formatNumber(collectibles.collectibleCount), 'Limited and collectible inventory rows'),
    metric(
      'Avatar items',
      robux(avatarItems.totalRobux),
      avatarItems.privateInventory
        ? 'Inventory private'
        : `${formatNumber(avatarItems.valuedItemCount)} of ${formatNumber(avatarItems.itemCount)} priced`
    ),
  ];
  if (purchases) {
    rows.push(metric('Robux spent', robux(purchases.totalRobuxSpent), `${purchases.purchaseCount} purchases scanned`));
  }

  const topItems = collectibles.topItems.length
    ? `<div class="bp-account-value-top">
        <div class="bp-account-value-subtitle">Top limiteds by RAP</div>
        ${collectibles.topItems
          .map(
            (item) => `
              <a class="bp-account-value-item" href="/catalog/${item.assetId}" title="${escapeHtml(item.name)}">
                <span>${escapeHtml(item.name)}</span>
                <strong>${robux(item.recentAveragePrice ?? 0)}</strong>
              </a>
            `
          )
          .join('')}
      </div>`
    : '';

  const scopeBase = isOwnProfile
    ? 'Limited RAP + current catalog prices of your avatar items + your authenticated purchase history. Some items appear in both purchase spend and avatar prices.'
    : 'Limited RAP + current catalog prices of public avatar items. Purchase history is hidden by Roblox for other profiles.';
  const collectibleTrunc = collectibles.truncated
    ? ` Scanned ${formatNumber(collectibles.scannedPages * 100)}+ collectible rows; very large inventories may be partial.`
    : '';
  const itemsTrunc = avatarItems.truncated
    ? ` Capped at ${formatNumber(avatarItems.scannedPages * 100)} avatar items.`
    : '';

  renderFrame(
    root,
    userId,
    true,
    scopeBase + collectibleTrunc + itemsTrunc,
    `
    <div class="bp-account-value-grid">${rows.join('')}</div>
    ${topItems}
  `
  );
}

function renderFrame(
  root: HTMLElement,
  userId: number,
  expanded: boolean,
  subtitle: string,
  bodyHtml: string
): void {
  root.dataset.bpUserId = String(userId);
  root.innerHTML = `
    <button class="bp-account-value-toggle" type="button" aria-expanded="${expanded ? 'true' : 'false'}">
      <span class="bp-account-value-chevron" aria-hidden="true"></span>
      <span class="bp-account-value-title">
        <strong>Account Value</strong>
        <small>${escapeHtml(subtitle)}</small>
      </span>
      <span class="bp-account-value-open-label">${expanded ? 'Hide' : 'Show'}</span>
    </button>
    <div class="bp-account-value-body" ${expanded ? '' : 'hidden'}>${bodyHtml}</div>
  `;
  attachToggle(root, userId);
}

function attachToggle(root: HTMLElement, userId: number): void {
  const button = root.querySelector<HTMLButtonElement>('.bp-account-value-toggle');
  if (!button) return;
  button.addEventListener('click', () => {
    const expanded = button.getAttribute('aria-expanded') === 'true';
    if (loadedForUser === userId && loadedForPath === location.pathname) {
      setExpanded(root, !expanded);
      return;
    }
    if (expanded && inflightForUser !== userId) {
      setExpanded(root, false);
      return;
    }
    void loadValue(root, userId);
  });
}

function setExpanded(root: HTMLElement, expanded: boolean): void {
  const button = root.querySelector<HTMLButtonElement>('.bp-account-value-toggle');
  const body = root.querySelector<HTMLElement>('.bp-account-value-body');
  const label = root.querySelector<HTMLElement>('.bp-account-value-open-label');
  button?.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  if (body) body.hidden = !expanded;
  if (label) label.textContent = expanded ? 'Hide' : 'Show';
}

function metric(label: string, value: string, detail: string): string {
  return `
    <div class="bp-account-value-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail)}</small>
    </div>
  `;
}

function readProfileUserId(): number | null {
  const m = location.pathname.match(/^\/users\/(\d+)\/profile/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function robux(n: number): string {
  return `R$ ${formatNumber(Math.round(n))}`;
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .bp-account-value-card {
      margin: 16px 0;
      padding: 0;
      border-radius: 8px;
      background: rgba(24, 28, 34, 0.95);
      border: 1px solid rgba(255,255,255,0.10);
      color: rgba(255,255,255,0.92);
      box-shadow: 0 8px 24px rgba(0,0,0,0.18);
      overflow: hidden;
    }
    .bp-account-value-toggle {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 16px;
      border: 0;
      background: transparent;
      color: inherit;
      text-align: left;
      cursor: pointer;
    }
    .bp-account-value-toggle:hover {
      background: rgba(255,255,255,0.04);
    }
    .bp-account-value-chevron {
      width: 9px;
      height: 9px;
      border-right: 2px solid currentColor;
      border-bottom: 2px solid currentColor;
      transform: rotate(-45deg);
      opacity: 0.75;
      transition: transform 0.14s ease;
      flex: 0 0 auto;
    }
    .bp-account-value-toggle[aria-expanded="true"] .bp-account-value-chevron {
      transform: rotate(45deg);
    }
    .bp-account-value-title {
      min-width: 0;
      flex: 1 1 auto;
      display: block;
    }
    .bp-account-value-title strong {
      display: block;
      margin: 0 0 3px;
      font-size: 18px;
      line-height: 1.2;
      font-weight: 800;
      color: inherit;
    }
    .bp-account-value-title small {
      display: block;
      margin: 0;
      max-width: 760px;
      font-size: 12px;
      line-height: 1.45;
      color: rgba(255,255,255,0.68);
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bp-account-value-open-label {
      flex: 0 0 auto;
      padding: 4px 9px;
      border-radius: 999px;
      background: rgba(255,255,255,0.08);
      font-size: 11px;
      font-weight: 800;
      color: rgba(255,255,255,0.78);
    }
    .bp-account-value-body {
      padding: 0 16px 16px 37px;
    }
    .bp-account-value-grid {
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
    .bp-account-value-metric span,
    .bp-account-value-metric small {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bp-account-value-metric span {
      font-size: 11px;
      font-weight: 700;
      color: rgba(255,255,255,0.62);
      text-transform: uppercase;
    }
    .bp-account-value-metric strong {
      display: block;
      margin: 3px 0;
      font-size: 18px;
      line-height: 1.2;
      color: #fff;
      overflow-wrap: anywhere;
    }
    .bp-account-value-metric small {
      font-size: 11px;
      color: rgba(255,255,255,0.58);
    }
    .bp-account-value-top {
      margin-top: 12px;
    }
    .bp-account-value-subtitle {
      margin-bottom: 6px;
      font-size: 12px;
      font-weight: 800;
      color: rgba(255,255,255,0.72);
    }
    .bp-account-value-item {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 7px 0;
      border-top: 1px solid rgba(255,255,255,0.08);
      color: inherit;
      text-decoration: none;
      font-size: 12px;
    }
    .bp-account-value-item span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bp-account-value-item strong {
      flex: 0 0 auto;
    }
    .bp-account-value-skeleton {
      height: 74px;
      border-radius: 8px;
      background: linear-gradient(90deg, rgba(255,255,255,0.05), rgba(255,255,255,0.11), rgba(255,255,255,0.05));
      background-size: 220% 100%;
      animation: bp-account-value-pulse 1.2s ease-in-out infinite;
    }
    @keyframes bp-account-value-pulse {
      0% { background-position: 100% 0; }
      100% { background-position: 0 0; }
    }
    body:not(.dark-theme) .bp-account-value-card {
      background: #fff;
      border-color: rgba(0,0,0,0.10);
      color: #272930;
      box-shadow: 0 6px 18px rgba(0,0,0,0.08);
    }
    body:not(.dark-theme) .bp-account-value-toggle:hover {
      background: rgba(0,0,0,0.035);
    }
    body:not(.dark-theme) .bp-account-value-title small,
    body:not(.dark-theme) .bp-account-value-metric span,
    body:not(.dark-theme) .bp-account-value-metric small,
    body:not(.dark-theme) .bp-account-value-subtitle {
      color: rgba(39,41,48,0.62);
    }
    body:not(.dark-theme) .bp-account-value-open-label {
      background: rgba(0,0,0,0.06);
      color: rgba(39,41,48,0.68);
    }
    body:not(.dark-theme) .bp-account-value-metric {
      background: rgba(0,0,0,0.035);
      border-color: rgba(0,0,0,0.06);
    }
    body:not(.dark-theme) .bp-account-value-metric strong {
      color: #191b22;
    }
    body:not(.dark-theme) .bp-account-value-item {
      border-top-color: rgba(0,0,0,0.08);
    }
  `;
  document.head.appendChild(style);
}
