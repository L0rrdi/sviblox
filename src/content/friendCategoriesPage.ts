/**
 * Inline friend-category assignment on `/users/friends`.
 *
 * Category creation/editing lives in the SviBlox popup. This content module only
 * adds a small menu button to Roblox-native friend cards so assignments can be
 * made in context, directly from the friends page.
 */

import { getSettings } from '@/storage/settingsStore';
import {
  ensureFriendCategoriesPrimed,
  getFriendCategoriesState,
  getCategoryForFriend,
  onFriendCategoriesChanged,
  createCategory,
  updateCategory,
  deleteCategory,
  assignFriend,
  FriendCategory,
  FRIEND_CATEGORY_LIMITS,
} from '@/storage/friendCategoriesStore';
import { categoryGradient } from './friendCategoryDecorator';
import { escapeHtml, escapeAttr } from '@/util/html';

const STYLE_ID = 'bloxplus-friend-category-assigner-style';
const MENU_ID = 'bloxplus-friend-category-menu';
const PANEL_ID = 'bloxplus-friend-category-create-panel';
const BUTTON_CLASS = 'bp-fcat-assign-btn';
const CARD_ATTR = 'data-bp-fcat-assign-card';
const INSTALLED_FLAG = '__bpFriendCategoryAssignerInstalled';

const ICON_OPTIONS = [
  ['user', '👤', 'Friend'],
  ['home', '⌂', 'Home'],
  ['handshake', '🤝', 'Trusted'],
  ['trophy', '🏆', 'Trophy'],
  ['star', '★', 'Favorite'],
  ['briefcase', '▣', 'Work'],
  ['graduate', '◒', 'School'],
  ['gamepad', '🎮', 'Gaming'],
  ['heart', '♥', 'Close'],
] as const;

let enabledCache = false;
let subscribed = false;
let openUserId: number | null = null;

export function install(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w[INSTALLED_FLAG]) return;
  w[INSTALLED_FLAG] = true;

  document.addEventListener('click', handleDocumentClick);
  window.addEventListener('scroll', closeMenu, true);
  window.addEventListener('resize', closeMenu);
}

export function run(): void {
  void runAsync();
}

async function runAsync(): Promise<void> {
  const settings = await getSettings();
  enabledCache = Boolean(settings.showFriendCategories);
  if (!enabledCache || !isFriendsPage()) {
    cleanup();
    return;
  }

  await ensureFriendCategoriesPrimed();
  ensureStyle();
  if (!subscribed) {
    subscribed = true;
    onFriendCategoriesChanged(() => {
      if (!enabledCache || !isFriendsPage()) return;
      closeMenu();
      decorateCards(true);
    });
  }
  decorateCards(false);
}

function isFriendsPage(): boolean {
  return /^\/users\/friends\/?$/.test(location.pathname);
}

function decorateCards(force: boolean): void {
  for (const card of friendCards()) {
    const userId = extractUserId(card);
    if (!userId) continue;
    const cat = getCategoryForFriend(userId);
    const stamp = `${userId}:${cat?.id ?? ''}`;
    if (!force && card.getAttribute(CARD_ATTR) === stamp) continue;

    card.setAttribute(CARD_ATTR, stamp);
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative';

    let btn = card.querySelector<HTMLButtonElement>(`:scope > .${BUTTON_CLASS}`);
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = BUTTON_CLASS;
      btn.innerHTML = assignIconSvg();
      card.appendChild(btn);
    }
    btn.dataset.userId = String(userId);
    btn.classList.toggle('bp-fcat-assign-active', Boolean(cat));
    btn.setAttribute('aria-label', cat ? `Category: ${cat.name}` : 'Assign friend category');
    btn.title = cat ? `Category: ${cat.name}` : 'Assign friend category';
    btn.style.removeProperty('--bp-fcat-c1');
    btn.style.removeProperty('--bp-fcat-c2');
    if (cat) {
      const [c1, c2] = categoryGradient(cat.color, cat.color2);
      btn.style.setProperty('--bp-fcat-c1', c1);
      btn.style.setProperty('--bp-fcat-c2', c2);
    }
  }
}

function friendCards(): HTMLElement[] {
  const containers = [...document.querySelectorAll<HTMLElement>('.avatar-card-container')];
  const fallbackLis = [...document.querySelectorAll<HTMLElement>('li.avatar-card.list-item')].filter(
    (li) => !li.querySelector('.avatar-card-container')
  );
  return [...containers, ...fallbackLis];
}

function handleDocumentClick(event: MouseEvent): void {
  const target = event.target as Element | null;
  const custom = target?.closest<HTMLElement>('[data-bp-fcat-custom]');
  if (custom) {
    event.preventDefault();
    event.stopPropagation();
    const userId = Number(custom.dataset.userId);
    if (Number.isFinite(userId) && userId > 0) {
      closeMenu();
      openCustomPanel(userId);
    }
    return;
  }

  const edit = target?.closest<HTMLElement>('[data-bp-fcat-edit]');
  if (edit) {
    event.preventDefault();
    event.stopPropagation();
    const userId = Number(edit.dataset.userId);
    const categoryId = edit.dataset.categoryId;
    if (categoryId) {
      closeMenu();
      openCustomPanel(Number.isFinite(userId) ? userId : 0, categoryId);
    }
    return;
  }

  const panelDelete = target?.closest<HTMLElement>('[data-bp-fcat-panel-delete]');
  if (panelDelete) {
    event.preventDefault();
    event.stopPropagation();
    const categoryId = panelDelete.dataset.categoryId;
    if (categoryId) {
      void deleteCategory(categoryId);
      closeCustomPanel();
    }
    return;
  }

  const panelClose = target?.closest<HTMLElement>('[data-bp-fcat-panel-close]');
  if (panelClose) {
    event.preventDefault();
    event.stopPropagation();
    closeCustomPanel();
    return;
  }

  const menuItem = target?.closest<HTMLElement>('[data-bp-fcat-menu-item]');
  if (menuItem) {
    event.preventDefault();
    event.stopPropagation();
    const userId = Number(menuItem.dataset.userId);
    if (Number.isFinite(userId) && userId > 0) {
      void assignFriend(userId, menuItem.dataset.categoryId || null);
    }
    closeMenu();
    return;
  }

  const btn = target?.closest<HTMLButtonElement>(`.${BUTTON_CLASS}`);
  if (btn) {
    event.preventDefault();
    event.stopPropagation();
    const userId = Number(btn.dataset.userId);
    if (!Number.isFinite(userId) || userId <= 0) return;
    if (openUserId === userId) {
      closeMenu();
    } else {
      openMenu(btn, userId);
    }
    return;
  }

  if (target && !target.closest(`#${MENU_ID}`)) closeMenu();
}

function openMenu(anchor: HTMLElement, userId: number): void {
  closeMenu();
  openUserId = userId;

  const menu = document.createElement('div');
  menu.id = MENU_ID;
  menu.className = 'bp-fcat-menu';
  menu.dataset.userId = String(userId);
  menu.innerHTML = menuHtml(userId);
  document.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const top = Math.min(window.innerHeight - menuRect.height - 8, rect.bottom + 6);
  const left = Math.min(window.innerWidth - menuRect.width - 8, rect.right - menuRect.width);
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, left)}px`;
}

function menuHtml(userId: number): string {
  const { categories } = getFriendCategoriesState();
  const assigned = getCategoryForFriend(userId)?.id ?? '';
  const noneActive = assigned ? '' : ' bp-fcat-menu-item-active';
  const items = categories.length
    ? categories.map((cat) => categoryItemHtml(userId, cat, cat.id === assigned)).join('')
    : `<div class="bp-fcat-menu-empty">Create categories in the SviBlox popup.</div>`;
  return `
    <div class="bp-fcat-menu-title">Assign category</div>
    <button type="button" class="bp-fcat-menu-item${noneActive}" data-bp-fcat-menu-item
      data-user-id="${userId}" data-category-id="">
      <span class="bp-fcat-menu-icon bp-fcat-menu-icon-none">${assignIconSvg()}</span>
      <span class="bp-fcat-menu-copy">
        <span class="bp-fcat-menu-name">No category</span>
        <span class="bp-fcat-menu-sub">Remove the avatar ring</span>
      </span>
    </button>
    ${items}
    <button type="button" class="bp-fcat-menu-item bp-fcat-menu-custom"
      data-bp-fcat-custom data-user-id="${userId}">
      <span class="bp-fcat-menu-icon bp-fcat-menu-custom-icon">+</span>
      <span class="bp-fcat-menu-copy">
        <span class="bp-fcat-menu-name">Custom</span>
        <span class="bp-fcat-menu-sub">Create a new connection type</span>
      </span>
    </button>
  `;
}

function categoryItemHtml(userId: number, cat: FriendCategory, active: boolean): string {
  const [c1, c2] = categoryGradient(cat.color, cat.color2);
  return `
    <div class="bp-fcat-menu-row" style="--bp-fcat-c1:${escapeAttr(c1)};--bp-fcat-c2:${escapeAttr(
      c2
    )}">
      <button type="button" class="bp-fcat-menu-item${active ? ' bp-fcat-menu-item-active' : ''}"
        data-bp-fcat-menu-item data-user-id="${userId}" data-category-id="${escapeAttr(cat.id)}">
        <span class="bp-fcat-menu-icon bp-fcat-menu-swatch">${categoryIconHtml(cat)}</span>
        <span class="bp-fcat-menu-copy">
          <span class="bp-fcat-menu-name">${escapeHtml(cat.name)}</span>
          <span class="bp-fcat-menu-sub">${
            cat.description
              ? escapeHtml(cat.description)
              : `Assign this friend to ${escapeHtml(cat.name)}`
          }</span>
        </span>
      </button>
      <button type="button" class="bp-fcat-menu-edit" data-bp-fcat-edit
        data-user-id="${userId}" data-category-id="${escapeAttr(cat.id)}"
        title="Edit ${escapeAttr(cat.name)}" aria-label="Edit ${escapeAttr(cat.name)}">
        ${editIconSvg()}
      </button>
    </div>
  `;
}

function categoryIconHtml(cat: FriendCategory): string {
  if (cat.emoji) return escapeHtml(cat.emoji);
  switch (cat.icon) {
    case 'home':
      return '⌂';
    case 'handshake':
      return '🤝';
    case 'trophy':
      return '🏆';
    case 'star':
      return '★';
    case 'briefcase':
      return '▣';
    case 'graduate':
      return '◒';
    case 'gamepad':
      return '🎮';
    case 'heart':
      return '♥';
    default:
      return '👤';
  }
}

function closeMenu(): void {
  document.getElementById(MENU_ID)?.remove();
  openUserId = null;
}

function openCustomPanel(userId: number, editCategoryId?: string): void {
  closeCustomPanel();
  const editCat = editCategoryId
    ? getFriendCategoriesState().categories.find((c) => c.id === editCategoryId) ?? null
    : null;
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.className = 'bp-fcat-panel-wrap';
  panel.innerHTML = customPanelHtml(userId, editCat);
  document.body.appendChild(panel);
  bindCustomPanel(panel, userId, editCat);
  panel.querySelector<HTMLInputElement>('[name="label"]')?.focus();
}

function closeCustomPanel(): void {
  document.getElementById(PANEL_ID)?.remove();
}

function customPanelHtml(userId: number, editCat: FriendCategory | null): string {
  const isEdit = Boolean(editCat);
  const color = editCat?.color ?? '#ff5aa5';
  const color2 = editCat?.color2 ?? '#6f55ff';
  const selectedIcon = editCat?.icon ?? 'user';
  const priority = editCat?.priority ?? 50;
  return `
    <div class="bp-fcat-panel-backdrop" data-bp-fcat-panel-close></div>
    <form class="bp-fcat-panel" data-user-id="${userId}"${
      editCat ? ` data-edit-id="${escapeAttr(editCat.id)}"` : ''
    }>
      <div class="bp-fcat-panel-head">
        <div>
          <h2>Manage Connection Types</h2>
          <p>Create and manage custom connection types for your friends</p>
        </div>
        <button type="button" class="bp-fcat-panel-x" data-bp-fcat-panel-close aria-label="Close">×</button>
      </div>
      <div class="bp-fcat-panel-body">
        <h3>${isEdit ? 'Edit Connection Type' : 'Create New Connection Type'}</h3>
        <label class="bp-fcat-field">
          <span>Label *</span>
          <input name="label" class="bp-fcat-input" maxlength="${FRIEND_CATEGORY_LIMITS.nameMax}"
            placeholder="e.g., Colleague, Gaming Buddy" required value="${escapeAttr(
              editCat?.name ?? ''
            )}" />
        </label>
        <label class="bp-fcat-field">
          <span>Description *</span>
          <textarea name="description" class="bp-fcat-textarea" maxlength="${
            FRIEND_CATEGORY_LIMITS.descriptionMax
          }"
            placeholder="Describe this connection type...">${escapeHtml(
              editCat?.description ?? ''
            )}</textarea>
        </label>
        <label class="bp-fcat-field bp-fcat-field-short">
          <span>Priority *</span>
          <input name="priority" class="bp-fcat-number" type="number" min="0" max="1000" value="${priority}" />
          <small>Higher values appear first (0-1000).</small>
        </label>
        <div class="bp-fcat-field">
          <span>Color *</span>
          <div class="bp-fcat-color-row">
            <label><input name="color" type="color" value="${escapeAttr(
              color
            )}" /><span>${escapeHtml(color.toUpperCase())}</span></label>
            <label><input name="color2" type="color" value="${escapeAttr(
              color2
            )}" /><span>${escapeHtml(color2.toUpperCase())}</span></label>
          </div>
        </div>
        <div class="bp-fcat-field">
          <span>Icon</span>
          <div class="bp-fcat-icon-grid" data-selected-icon="${escapeAttr(selectedIcon)}">
            ${ICON_OPTIONS.map(
              ([id, glyph, label]) => `
                <button type="button" class="bp-fcat-icon-choice${
                  id === selectedIcon ? ' bp-fcat-icon-selected' : ''
                }"
                  data-icon="${id}" title="${escapeAttr(label)}" aria-label="${escapeAttr(
                    label
                  )}">${glyph}</button>
              `
            ).join('')}
          </div>
        </div>
        <label class="bp-fcat-field">
          <span>Custom Emoji (Optional)</span>
          <input name="emoji" class="bp-fcat-input" maxlength="12" placeholder="💜 or any emoji" value="${escapeAttr(
            editCat?.emoji ?? ''
          )}" />
          <small>Use a custom emoji instead of the premade icons above.</small>
        </label>
        <div class="bp-fcat-panel-actions">
          ${
            editCat && !editCat.builtIn
              ? `<button type="button" class="bp-fcat-delete" data-bp-fcat-panel-delete
                  data-category-id="${escapeAttr(editCat.id)}">Delete</button>`
              : ''
          }
          <button type="submit" class="bp-fcat-create">${isEdit ? 'Save' : 'Create'}</button>
          <button type="button" class="bp-fcat-cancel" data-bp-fcat-panel-close>Cancel</button>
        </div>
      </div>
    </form>
  `;
}

function bindCustomPanel(root: HTMLElement, userId: number, editCat: FriendCategory | null): void {
  const colorInputs = root.querySelectorAll<HTMLInputElement>('input[type="color"]');
  for (const input of colorInputs) {
    const label = input.nextElementSibling;
    input.addEventListener('input', () => {
      if (label) label.textContent = input.value.toUpperCase();
    });
  }

  const grid = root.querySelector<HTMLElement>('.bp-fcat-icon-grid');
  grid?.addEventListener('click', (event) => {
    const btn = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-icon]');
    if (!btn) return;
    grid.dataset.selectedIcon = btn.dataset.icon ?? 'user';
    for (const el of grid.querySelectorAll('.bp-fcat-icon-selected')) {
      el.classList.remove('bp-fcat-icon-selected');
    }
    btn.classList.add('bp-fcat-icon-selected');
  });

  const form = root.querySelector<HTMLFormElement>('form');
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const name = String(data.get('label') ?? '').trim();
    if (!name) return;
    const color = String(data.get('color') ?? '#ff5aa5');
    const color2 = String(data.get('color2') ?? '#6f55ff');
    const description = String(data.get('description') ?? '').trim();
    const priority = Number(data.get('priority') ?? 50);
    const emoji = String(data.get('emoji') ?? '').trim();
    const icon = grid?.dataset.selectedIcon ?? 'user';
    if (editCat) {
      void updateCategory(editCat.id, {
        name,
        color,
        color2,
        description,
        priority,
        icon,
        emoji,
      }).then(closeCustomPanel);
    } else {
      void createCategory(name, color, color2, { description, priority, icon, emoji }).then(
        (cat) => {
          if (userId > 0) void assignFriend(userId, cat.id);
          closeCustomPanel();
        }
      );
    }
  });
}

function cleanup(): void {
  closeMenu();
  closeCustomPanel();
  for (const card of document.querySelectorAll<HTMLElement>(`[${CARD_ATTR}]`)) {
    card.removeAttribute(CARD_ATTR);
    card.querySelector<HTMLElement>(`:scope > .${BUTTON_CLASS}`)?.remove();
  }
  document.getElementById(STYLE_ID)?.remove();
}

function extractUserId(card: HTMLElement): number | null {
  const link = card.querySelector<HTMLAnchorElement>('a[href*="/users/"]');
  const linkMatch = link?.getAttribute('href')?.match(/\/users\/(\d+)/);
  if (linkMatch) {
    const n = Number(linkMatch[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const li = card.closest('li[id]') ?? (card.matches('li[id]') ? card : null);
  const liId = li?.getAttribute('id');
  if (liId && /^\d+$/.test(liId)) {
    const n = Number(liId);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function assignIconSvg(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M19 8v6" />
      <path d="M22 11h-6" />
    </svg>
  `;
}

function editIconSvg(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  `;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .${BUTTON_CLASS} {
      position: absolute;
      top: 10px;
      right: 10px;
      z-index: 4;
      width: 34px;
      height: 28px;
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 6px;
      background: rgba(35,37,40,0.86);
      color: rgba(255,255,255,0.78);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.22);
      transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
    }
    .${BUTTON_CLASS}:hover,
    .${BUTTON_CLASS}.bp-fcat-assign-active {
      color: #fff;
      border-color: color-mix(in srgb, var(--bp-fcat-c1, #8aa8ff) 58%, rgba(255,255,255,0.18));
      background:
        linear-gradient(rgba(35,37,40,0.82), rgba(35,37,40,0.82)) padding-box,
        linear-gradient(135deg, var(--bp-fcat-c1, #ff5aa5), var(--bp-fcat-c2, #6f55ff)) border-box;
    }
    .${BUTTON_CLASS} svg {
      width: 17px;
      height: 17px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
      pointer-events: none;
    }
    .bp-fcat-menu {
      position: fixed;
      z-index: 2147483646;
      width: 300px;
      max-width: calc(100vw - 16px);
      padding: 10px;
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 8px;
      background: #242628;
      color: #f4f4f5;
      box-shadow: 0 18px 42px rgba(0,0,0,0.48), inset 0 1px 0 rgba(255,255,255,0.04);
      font-family: Arial, Helvetica, sans-serif;
    }
    .bp-fcat-menu-title {
      padding: 2px 6px 8px;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: rgba(255,255,255,0.48);
    }
    .bp-fcat-menu-item {
      width: 100%;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: inherit;
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      gap: 10px;
      align-items: center;
      padding: 9px 8px;
      text-align: left;
      cursor: pointer;
      font: inherit;
    }
    .bp-fcat-menu-item:hover,
    .bp-fcat-menu-item-active {
      background: rgba(255,255,255,0.07);
    }
    .bp-fcat-menu-row {
      position: relative;
    }
    .bp-fcat-menu-row .bp-fcat-menu-item {
      padding-right: 38px;
    }
    .bp-fcat-menu-edit {
      position: absolute;
      top: 50%;
      right: 8px;
      transform: translateY(-50%);
      width: 26px;
      height: 26px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px;
      background: rgba(255,255,255,0.04);
      color: rgba(255,255,255,0.55);
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.12s ease, color 0.12s ease, border-color 0.12s ease, background 0.12s ease;
    }
    .bp-fcat-menu-row:hover .bp-fcat-menu-edit,
    .bp-fcat-menu-edit:focus-visible {
      opacity: 1;
    }
    .bp-fcat-menu-edit:hover {
      color: #fff;
      border-color: color-mix(in srgb, var(--bp-fcat-c1, #8aa8ff) 60%, rgba(255,255,255,0.18));
      background:
        linear-gradient(rgba(36,38,40,0.9), rgba(36,38,40,0.9)) padding-box,
        linear-gradient(135deg, var(--bp-fcat-c1, #ff5aa5), var(--bp-fcat-c2, #6f55ff)) border-box;
    }
    .bp-fcat-menu-edit svg {
      width: 14px;
      height: 14px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
      pointer-events: none;
    }
    .bp-fcat-menu-icon {
      width: 22px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: rgba(255,255,255,0.70);
    }
    .bp-fcat-menu-icon svg {
      width: 17px;
      height: 17px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .bp-fcat-menu-swatch {
      border-radius: 50%;
      background: radial-gradient(
        circle,
        var(--bp-fcat-c1, #ff5aa5) 48%,
        color-mix(in srgb, var(--bp-fcat-c1, #ff5aa5) 55%, var(--bp-fcat-c2, #6f55ff)) 64%,
        color-mix(in srgb, var(--bp-fcat-c2, #6f55ff) 82%, transparent) 84%,
        transparent 100%
      );
      color: #fff;
      font-size: 12px;
      font-weight: 900;
      box-shadow:
        inset 0 0 0 2px rgba(255,255,255,0.10),
        0 0 8px color-mix(in srgb, var(--bp-fcat-c1, #ff5aa5) 52%, transparent),
        0 0 16px color-mix(in srgb, var(--bp-fcat-c2, #6f55ff) 58%, transparent);
    }
    .bp-fcat-menu-copy {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .bp-fcat-menu-name {
      font-size: 14px;
      font-weight: 800;
      line-height: 1.1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bp-fcat-menu-sub {
      font-size: 12px;
      line-height: 1.25;
      color: rgba(255,255,255,0.42);
    }
    .bp-fcat-menu-empty {
      padding: 10px 8px;
      color: rgba(255,255,255,0.50);
      font-size: 12px;
      line-height: 1.35;
    }
    .bp-fcat-menu-custom {
      margin-top: 6px;
      border-top: 1px solid rgba(255,255,255,0.08);
      padding-top: 11px;
    }
    .bp-fcat-menu-custom-icon {
      border-radius: 50%;
      background: rgba(255,255,255,0.08);
      color: #fff;
      font-size: 18px;
      font-weight: 800;
    }
    .bp-fcat-panel-wrap {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 72px 18px 24px;
      box-sizing: border-box;
      font-family: Arial, Helvetica, sans-serif;
    }
    .bp-fcat-panel-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0,0,0,0.54);
      backdrop-filter: blur(2px);
    }
    .bp-fcat-panel {
      position: relative;
      width: min(680px, calc(100vw - 36px));
      max-height: calc(100vh - 96px);
      overflow-y: auto;
      background: #181b1d;
      color: #e8eaed;
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 6px;
      box-shadow: 0 22px 70px rgba(0,0,0,0.62), inset 0 1px 0 rgba(255,255,255,0.04);
    }
    .bp-fcat-panel-head {
      display: flex;
      justify-content: space-between;
      gap: 18px;
      padding: 18px 22px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .bp-fcat-panel-head h2 {
      margin: 0;
      max-width: 220px;
      color: rgba(255,255,255,0.72);
      font-size: 22px;
      line-height: 1.12;
    }
    .bp-fcat-panel-head p {
      margin: 6px 0 0;
      color: rgba(255,255,255,0.36);
      font-size: 13px;
      line-height: 1.25;
    }
    .bp-fcat-panel-x {
      width: 34px;
      height: 34px;
      border: 0;
      background: transparent;
      color: rgba(255,255,255,0.48);
      font-size: 30px;
      line-height: 1;
      cursor: pointer;
    }
    .bp-fcat-panel-body {
      padding: 30px 22px 18px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .bp-fcat-panel-body h3 {
      margin: 0 0 2px;
      color: rgba(255,255,255,0.76);
      font-size: 22px;
      line-height: 1.2;
    }
    .bp-fcat-field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      color: rgba(255,255,255,0.78);
      font-size: 13px;
      font-weight: 800;
    }
    .bp-fcat-field small {
      color: rgba(255,255,255,0.34);
      font-weight: 400;
      line-height: 1.25;
    }
    .bp-fcat-input,
    .bp-fcat-textarea,
    .bp-fcat-number {
      box-sizing: border-box;
      width: 100%;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.18);
      background: #1f2224;
      color: #e8eaed;
      font: 500 14px/1.3 Arial, Helvetica, sans-serif;
      padding: 10px 11px;
    }
    .bp-fcat-input:focus,
    .bp-fcat-textarea:focus,
    .bp-fcat-number:focus {
      outline: 1px solid #176ed6;
      border-color: #176ed6;
      box-shadow: 0 0 0 1px rgba(23,110,214,0.28);
    }
    .bp-fcat-textarea {
      min-height: 80px;
      resize: vertical;
    }
    .bp-fcat-field-short {
      max-width: 260px;
    }
    .bp-fcat-number {
      max-width: 120px;
    }
    .bp-fcat-color-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .bp-fcat-color-row label {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .bp-fcat-color-row input {
      width: 40px;
      height: 34px;
      padding: 0;
      border: 1px solid rgba(255,255,255,0.28);
      border-radius: 3px;
      background: #232628;
    }
    .bp-fcat-color-row span {
      min-width: 88px;
      padding: 9px 10px;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 4px;
      background: #232628;
      color: #fff;
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.02em;
    }
    .bp-fcat-icon-grid {
      display: grid;
      grid-template-columns: repeat(9, 38px);
      gap: 8px;
    }
    .bp-fcat-icon-choice {
      width: 38px;
      height: 38px;
      border-radius: 5px;
      border: 1px solid rgba(255,255,255,0.20);
      background: #232628;
      color: rgba(255,255,255,0.88);
      font-size: 18px;
      cursor: pointer;
    }
    .bp-fcat-icon-choice:hover,
    .bp-fcat-icon-selected {
      border-color: #176ed6;
      background: rgba(23,110,214,0.24);
      box-shadow: 0 0 0 1px rgba(23,110,214,0.38);
    }
    .bp-fcat-panel-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding-top: 4px;
    }
    .bp-fcat-delete {
      margin-right: auto;
      height: 36px;
      padding: 0 15px;
      border-radius: 5px;
      border: 1px solid rgba(229,72,77,0.55);
      background: rgba(229,72,77,0.14);
      color: #ff8b8f;
      font: 800 13px/1 Arial, Helvetica, sans-serif;
      cursor: pointer;
    }
    .bp-fcat-delete:hover {
      background: rgba(229,72,77,0.26);
      color: #fff;
    }
    .bp-fcat-create,
    .bp-fcat-cancel {
      height: 36px;
      padding: 0 15px;
      border-radius: 5px;
      border: 0;
      font: 800 13px/1 Arial, Helvetica, sans-serif;
      cursor: pointer;
    }
    .bp-fcat-create {
      background: #2f3438;
      color: #fff;
    }
    .bp-fcat-create:hover {
      background: #3a4045;
    }
    .bp-fcat-cancel {
      background: rgba(255,255,255,0.09);
      color: rgba(255,255,255,0.70);
    }
  `;
  document.head.appendChild(style);
}
