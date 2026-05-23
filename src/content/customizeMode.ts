/**
 * Customize mode — entered via `location.hash = '#bloxplus-customize'`.
 * Blocks all normal Roblox interactions (capture-phase click interceptor
 * with preventDefault), outlines customizable elements on hover, and opens
 * a right-side drawer for editing the clicked target. PR 1 supports left-nav
 * items only; rename + hide + custom icon edits are persisted via
 * `customizationStore`.
 *
 * Master switch: when `Settings.showCustomize` is false, this module is a
 * no-op — the click interceptor is removed and the drawer is torn down so
 * the user can never get stuck in mode if they panic-toggle.
 */

import { getSettings, onSettingsChanged } from '@/storage/settingsStore';
import {
  addCustomButton,
  ElementEdit,
  clearAllCustomizations,
  getCachedCustomizations,
  getCustomizations,
  onCustomizationsChanged,
  removeCustomButton,
  removeEntry,
  setEntry,
  setLeftNavOrder,
  updateCustomButton,
} from '@/storage/customizationStore';
import { animatedIconOptions, animatedIconSvg, isAnimatedIconPresetId } from './customizeAnimatedIcons';
import { escapeHtml, escapeAttr } from '@/util/html';
import {
  buildFallbackSelector,
  customId,
  findCustomizableAncestor,
  resolveById,
  tagAll,
} from './customizeIdentity';

const ROUTE_HASH = 'bloxplus-customize';
const DRAWER_ID = 'bloxplus-customize-drawer';
const STYLE_ID = 'bloxplus-customize-style';
const BODY_CLASS = 'bp-customize-mode';

let installed = false;
let active = false;
let selectedId: string | null = null;
let pendingCustomIconDataUrl = '';
let iconColorToolsForId: string | null = null;
let lastIconTintColor = '#4a90e2';

type EyeDropperWindow = Window & {
  EyeDropper?: new () => {
    open: () => Promise<{ sRGBHex: string }>;
  };
};

export function install(): void {
  if (installed) return;
  installed = true;
  ensureStyle();
  window.addEventListener('hashchange', () => run());
  window.addEventListener('popstate', () => run());
  onSettingsChanged((s) => {
    if (!s.showCustomize && active) exitMode();
  });
  onCustomizationsChanged(() => {
    if (!active) return;
    const drawer = document.getElementById(DRAWER_ID);
    if (!drawer) return;
    // Don't blow away the drawer body while the user is mid-typing in a
    // text input — that would kill focus on every keystroke. Just refresh
    // the footer counter; the user's edits are already reflected in storage.
    if (isTextEntryFocused(drawer)) {
      refreshCounter(drawer);
      return;
    }
    renderDrawer();
  });
  // Prime the store so the drawer can read synchronously.
  void getCustomizations();
}

export function run(): void {
  void runAsync();
}

async function runAsync(): Promise<void> {
  const settings = await getSettings();
  const wantActive = settings.showCustomize && isCustomizeRoute();
  if (wantActive && !active) enterMode();
  else if (!wantActive && active) exitMode();
  // If active and the drawer was removed by something else (overlay handoff,
  // panic state), re-mount it.
  if (active && !document.getElementById(DRAWER_ID)) mountDrawer();
  if (active) syncInlineOrderControls();
}

function isCustomizeRoute(): boolean {
  return location.hash.replace(/^#/, '') === ROUTE_HASH;
}

function enterMode(): void {
  active = true;
  document.body.classList.add(BODY_CLASS);
  document.addEventListener('click', clickInterceptor, true);
  document.addEventListener('keydown', keyHandler, true);
  mountDrawer();
  syncInlineOrderControls();
}

function exitMode(): void {
  active = false;
  selectedId = null;
  document.body.classList.remove(BODY_CLASS);
  document.removeEventListener('click', clickInterceptor, true);
  document.removeEventListener('keydown', keyHandler, true);
  document.getElementById(DRAWER_ID)?.remove();
  cleanupInlineOrderControls();
  if (isCustomizeRoute()) {
    history.replaceState(history.state, '', location.pathname + location.search);
  }
}

function clickInterceptor(e: MouseEvent): void {
  const drawer = document.getElementById(DRAWER_ID);
  if (drawer && drawer.contains(e.target as Node)) return; // drawer owns its events
  if ((e.target as Element).closest?.('.bp-cust-inline-order')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const li = findCustomizableAncestor(e.target as Element);
  if (!li) return;
  const nextId = customId(li);
  // Toggle: clicking the already-selected nav item closes the editor.
  selectedId = selectedId === nextId ? null : nextId;
  renderDrawer();
}

function keyHandler(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    exitMode();
  }
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

function mountDrawer(): void {
  if (document.getElementById(DRAWER_ID)) return;
  const drawer = document.createElement('aside');
  drawer.id = DRAWER_ID;
  document.body.appendChild(drawer);
  renderDrawer();
}

function isTextEntryFocused(drawer: HTMLElement): boolean {
  const ae = document.activeElement as HTMLElement | null;
  if (!ae || !drawer.contains(ae)) return false;
  if (ae.tagName === 'TEXTAREA') return true;
  if (ae.tagName !== 'INPUT') return false;
  const t = (ae as HTMLInputElement).type;
  return t === 'text' || t === 'url' || t === 'search' || t === 'email' || t === 'color';
}

function refreshCounter(drawer: HTMLElement): void {
  const spec = getCachedCustomizations();
  const count = Object.keys(spec.entries).length + (spec.leftNavOrder?.length ? 1 : 0) + (spec.customButtons?.length ?? 0);
  const counterEl = drawer.querySelector('.bp-cust-counts');
  if (counterEl) counterEl.textContent = `${count} customization${count === 1 ? '' : 's'} active`;
  // Also refresh the "Your customizations" list — the editor body (inputs)
  // is left untouched so focus survives, but the list reflects the latest
  // chips (Renamed / Hidden / Icon) as the user types.
  const listHost = drawer.querySelector<HTMLElement>('[data-bp-list-host]');
  if (listHost) {
    listHost.innerHTML = renderActiveList(spec);
    bindListEvents(drawer);
  }
}

function renderDrawer(): void {
  const drawer = document.getElementById(DRAWER_ID);
  if (!drawer) return;

  const spec = getCachedCustomizations();
  const hasCustomOrder = Boolean(spec.leftNavOrder?.length);
  const entryCount = Object.keys(spec.entries).length + (hasCustomOrder ? 1 : 0) + (spec.customButtons?.length ?? 0);
  const selected = selectedId
    ? { id: selectedId, edit: spec.entries[selectedId] ?? {} }
    : null;
  const selectedEl = selectedId ? resolveById(selectedId, spec.entries[selectedId]?.fallbackSelector) : null;
  const selectedCustomButton = selectedId ? customButtonForId(selectedId, spec) : undefined;
  const selectedIconUrl = selected?.edit.iconDataUrl || selectedCustomButton?.iconDataUrl || '';
  const selectedIconPreset = selected?.edit.iconPreset || selectedCustomButton?.iconPreset;
  const labelText =
    cleanEditText(selected?.edit.text, selectedId) ||
    selectedCustomButton?.label ||
    (selectedEl ? targetText(selectedEl).slice(0, 60) : selectedId ?? '');

  drawer.innerHTML = `
    <header class="bp-cust-drawer-header">
      <h2>Customize</h2>
      <button type="button" class="bp-cust-btn bp-cust-btn-ghost" data-action="exit">Exit</button>
    </header>
    <div class="bp-cust-drawer-body">
      ${renderAddButtonForm()}
      <div data-bp-list-host>${renderActiveList(spec)}</div>
      <div data-bp-editor-host>${selected ? renderSelected(selected.edit, labelText, selectedIconUrl, selectedIconPreset) : renderEmpty()}</div>
    </div>
    <footer class="bp-cust-drawer-footer">
      <div class="bp-cust-counts">${entryCount} customization${entryCount === 1 ? '' : 's'} active</div>
      <button type="button" class="bp-cust-btn bp-cust-btn-danger" data-action="reset-all">Reset all</button>
    </footer>
  `;
  bindDrawerEvents(drawer);
}

function getSiblingTargets(el: HTMLElement): ReturnType<typeof tagAll> {
  const parent = el.parentElement;
  if (!parent) return [];
  return tagAll().filter((target) => target.surface === 'leftnav' && target.el.parentElement === parent);
}

function getNavTargets(): ReturnType<typeof tagAll> {
  return tagAll().filter((target) => target.surface === 'leftnav');
}

function targetText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelector('.bp-cust-inline-order')?.remove();
  return clone.textContent?.trim() ?? '';
}

function customButtonForId(
  id: string,
  spec: ReturnType<typeof getCachedCustomizations>
) {
  return (spec.customButtons ?? []).find((button) => `leftnav::custom-button-${button.id}` === id);
}

function cleanEditText(text: string | undefined, id: string | null): string {
  if (!text) return '';
  if (id?.startsWith('leftnav::custom-button-') && text.startsWith('leftnav::custom-button-')) return '';
  return text;
}

function renderAddButtonForm(): string {
  return `
    <section class="bp-cust-add-section">
      <h3 class="bp-cust-list-heading">Add custom button</h3>
      <label class="bp-cust-field">
        <span>Name</span>
        <input type="text" data-field="newLabel" placeholder="Button name" maxlength="40" />
      </label>
      <label class="bp-cust-field">
        <span>URL</span>
        <input type="url" data-field="newUrl" placeholder="https://www.roblox.com/..." />
      </label>
      <label class="bp-cust-field">
        <span>Built-in icon</span>
        <select data-field="newIconPreset">${animatedIconOptions(undefined)}</select>
      </label>
      <label class="bp-cust-field">
        <span>Image URL</span>
        <input type="url" data-field="newIconUrl" placeholder="...or upload an image" value="${escapeAttr(pendingCustomIconDataUrl.startsWith('data:') ? '' : pendingCustomIconDataUrl)}" />
      </label>
      <div class="bp-cust-add-actions">
        <input type="file" accept="image/*" data-field="newIconFile" hidden />
        <button type="button" class="bp-cust-btn" data-action="new-icon-upload">Upload image</button>
        <button type="button" class="bp-cust-btn" data-action="add-custom-button">Add button</button>
      </div>
      ${pendingCustomIconDataUrl.startsWith('data:') ? '<div class="bp-cust-upload-ready">Uploaded image ready</div>' : ''}
    </section>
  `;
}

function syncInlineOrderControls(): void {
  const targets = getNavTargets();
  targets.forEach((target, index) => {
    const li = target.el;
    li.classList.add('bp-cust-inline-host');
    let controls = li.querySelector<HTMLElement>(':scope > .bp-cust-inline-order');
    if (!controls) {
      controls = document.createElement('div');
      controls.className = 'bp-cust-inline-order';
      controls.innerHTML = `
        <button type="button" data-inline-delta="-1" aria-label="Move up" title="Move up">↑</button>
        <button type="button" data-inline-delta="1" aria-label="Move down" title="Move down">↓</button>
      `;
      for (const btn of controls.querySelectorAll<HTMLButtonElement>('button')) {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const delta = btn.dataset.inlineDelta === '-1' ? -1 : 1;
          void moveById(customId(li), delta);
        });
      }
      li.appendChild(controls);
    }
    controls.querySelector<HTMLButtonElement>('[data-inline-delta="-1"]')!.disabled = index === 0;
    controls.querySelector<HTMLButtonElement>('[data-inline-delta="1"]')!.disabled = index === targets.length - 1;
  });
}

function cleanupInlineOrderControls(): void {
  for (const controls of document.querySelectorAll('.bp-cust-inline-order')) controls.remove();
  for (const host of document.querySelectorAll('.bp-cust-inline-host')) {
    host.classList.remove('bp-cust-inline-host');
  }
}

function renderActiveList(spec: ReturnType<typeof getCachedCustomizations>): string {
  const customIds = new Set((spec.customButtons ?? []).map((button) => `leftnav::custom-button-${button.id}`));
  const ids = [
    ...Object.keys(spec.entries),
    ...(spec.customButtons ?? [])
      .map((button) => `leftnav::custom-button-${button.id}`)
      .filter((id) => !spec.entries[id]),
  ];
  if (ids.length === 0) return '';
  const rows = ids
    .map((id) => {
      const edit = spec.entries[id] ?? {};
      const customButton = customButtonForId(id, spec);
      const el = resolveById(id, edit.fallbackSelector);
      // Prefer the rename (so the user sees the name they gave it). Fall back
      // to the original snapshot stored on the label dataset, then to the
      // current live text, then to a generic placeholder.
      const liveLabel = el ? targetText(el).slice(0, 36) : '';
      const displayLabel = cleanEditText(edit.text, id) || customButton?.label || liveLabel || '(unnamed)';
      const chips: string[] = [];
      if (customIds.has(id)) chips.push('Custom');
      if (edit.text) chips.push('Renamed');
      if (edit.hidden) chips.push('Hidden');
      if (edit.iconDataUrl || edit.iconPreset || customButton?.iconDataUrl || customButton?.iconPreset) chips.push('Icon');
      const missing = !el && !customButton;
      const group = primaryChip(chips);
      return { id, displayLabel, chips, group, missing };
    })
    .sort((a, b) => {
      const groupDiff = chipSortIndex(a.group) - chipSortIndex(b.group);
      if (groupDiff !== 0) return groupDiff;
      return a.displayLabel.localeCompare(b.displayLabel, undefined, { sensitivity: 'base' });
    });
  let currentGroup = '';
  const items = rows
    .map(({ id, displayLabel, chips, group, missing }) => {
      const classes = [
        'bp-cust-list-item',
        selectedId === id ? 'bp-cust-list-item-active' : '',
        missing ? 'bp-cust-list-item-missing' : '',
      ].filter(Boolean).join(' ');
      const groupHeader = group !== currentGroup
        ? `<div class="bp-cust-list-group bp-cust-list-group-${chipClass(group)}">${escapeHtml(group)}</div>`
        : '';
      currentGroup = group;
      return `
        ${groupHeader}
        <div class="${classes}">
          <button type="button" class="bp-cust-list-select" data-cust-select="${escapeAttr(id)}" title="Edit">
            <span class="bp-cust-list-name">${escapeHtml(displayLabel)}${missing ? ' <em class="bp-cust-missing-tag">(missing)</em>' : ''}</span>
            <span class="bp-cust-list-chips">${chips.map((c) => `<span class="bp-cust-chip bp-cust-chip-${chipClass(c)}">${c}</span>`).join('')}</span>
          </button>
          <button type="button" class="bp-cust-list-remove" data-cust-remove="${escapeAttr(id)}" aria-label="Remove customization" title="Remove">×</button>
        </div>
      `;
    })
    .join('');
  return `
    <section class="bp-cust-list-section">
      <h3 class="bp-cust-list-heading">Your customizations</h3>
      <div class="bp-cust-list">${items}</div>
    </section>
  `;
}

function primaryChip(chips: string[]): string {
  if (chips.includes('Hidden')) return 'Hidden';
  if (chips.includes('Renamed')) return 'Renamed';
  if (chips.includes('Icon')) return 'Icon';
  if (chips.includes('Custom')) return 'Custom';
  return 'Other';
}

function chipSortIndex(label: string): number {
  const order = ['Hidden', 'Renamed', 'Icon', 'Custom', 'Other'];
  const index = order.indexOf(label);
  return index === -1 ? order.length : index;
}

function bindListEvents(drawer: HTMLElement): void {
  for (const btn of drawer.querySelectorAll<HTMLButtonElement>('[data-cust-select]')) {
    btn.addEventListener('click', () => {
      const id = btn.dataset.custSelect ?? null;
      // Toggle: clicking the already-selected row closes the editor.
      if (id && id === selectedId) {
        selectedId = null;
        renderDrawer();
        return;
      }
      selectedId = id;
      const el = id ? resolveById(id, getCachedCustomizations().entries[id]?.fallbackSelector) : null;
      flashHighlight(el);
      renderDrawer();
    });
  }
  for (const btn of drawer.querySelectorAll<HTMLButtonElement>('[data-cust-remove]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.custRemove;
      if (!id) return;
      if (selectedId === id) selectedId = null;
      if (id.startsWith('leftnav::custom-button-')) {
        void removeCustomButton(id.replace('leftnav::custom-button-', ''));
      } else {
        void removeEntry(id);
      }
    });
  }
}

function flashHighlight(el: HTMLElement | null): void {
  if (!el) return;
  el.classList.add('bp-cust-flash');
  window.setTimeout(() => el.classList.remove('bp-cust-flash'), 600);
}

function renderEmpty(): string {
  return `
    <p class="bp-cust-hint">
      Click any left-nav item to edit it. You can rename, hide, or replace its icon.
      Press <kbd>Esc</kbd> or use the Exit button to leave customize mode.
    </p>
  `;
}

function chipClass(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function renderSelected(edit: ElementEdit, currentLabel: string, currentIconUrl: string, currentIconPreset: string | undefined): string {
  const hasAnimatedIcon = isAnimatedIconPresetId(currentIconPreset);
  const hasIcon = Boolean(currentIconUrl || hasAnimatedIcon);
  const isCustomButton = selectedId?.startsWith('leftnav::custom-button-');
  const renameValue = cleanEditText(edit.text, selectedId);
  const showColorTools = Boolean(currentIconUrl) && iconColorToolsForId === selectedId;
  const canEyeDrop = Boolean((window as EyeDropperWindow).EyeDropper);
  return `
    <div class="bp-cust-preview">
      <div class="bp-cust-preview-label">Editing:</div>
      <div class="bp-cust-preview-name">${escapeHtml(currentLabel || '(unnamed)')}</div>
    </div>

    <label class="bp-cust-field">
      <span>Rename</span>
      <input type="text" data-field="text" value="${escapeAttr(renameValue)}" placeholder="${escapeAttr(currentLabel)}" maxlength="40" />
    </label>

    <label class="bp-cust-field bp-cust-field-inline">
      <input type="checkbox" data-field="hidden" ${edit.hidden ? 'checked' : ''} />
      <span>Hide this item</span>
    </label>

    <fieldset class="bp-cust-icon-group">
      <legend>Custom icon</legend>
      <label class="bp-cust-field">
        <span>Built-in icon</span>
        <select data-field="iconPreset">${animatedIconOptions(currentIconPreset)}</select>
      </label>
      <div class="bp-cust-icon-row">
        <button type="button" class="bp-cust-icon-preview" data-action="icon-color-toggle" ${currentIconUrl ? 'title="Recolor icon"' : 'disabled'}>${
          currentIconUrl
            ? `<img src="${escapeAttr(currentIconUrl)}" alt="">`
            : isAnimatedIconPresetId(currentIconPreset)
              ? animatedIconSvg(currentIconPreset)
              : '<span class="bp-cust-icon-placeholder">default</span>'
        }</button>
        <div class="bp-cust-icon-actions">
          <input type="file" accept="image/*" data-field="iconFile" hidden />
          <button type="button" class="bp-cust-btn" data-action="icon-upload">Upload</button>
          <button type="button" class="bp-cust-btn bp-cust-btn-ghost" data-action="icon-clear" ${hasIcon ? '' : 'disabled'}>Use default</button>
        </div>
      </div>
      ${showColorTools ? `
        <div class="bp-cust-icon-color-popover">
          <input type="color" data-field="iconColor" value="${escapeAttr(lastIconTintColor)}" aria-label="Icon color" />
          <button type="button" class="bp-cust-btn" data-action="icon-color-apply">Apply color</button>
          <button type="button" class="bp-cust-btn bp-cust-btn-ghost" data-action="icon-color-eyedropper" ${canEyeDrop ? '' : 'disabled'}>Pick from screen</button>
        </div>
      ` : ''}
      <input type="url" data-field="iconUrl" placeholder="…or paste image URL" value="${
        edit.iconDataUrl && !edit.iconDataUrl.startsWith('data:') ? escapeAttr(edit.iconDataUrl) : ''
      }" />
    </fieldset>

    <div class="bp-cust-actions">
      <button type="button" class="bp-cust-btn bp-cust-btn-danger" data-action="reset-element">Reset this item</button>
      ${isCustomButton ? '<button type="button" class="bp-cust-btn bp-cust-btn-danger" data-action="delete-custom-button">Delete button</button>' : ''}
    </div>
  `;
}

function bindDrawerEvents(drawer: HTMLElement): void {
  bindListEvents(drawer);
  drawer.querySelector('[data-action="exit"]')?.addEventListener('click', () => exitMode());
  drawer.querySelector('[data-action="new-icon-upload"]')?.addEventListener('click', () => {
    drawer.querySelector<HTMLInputElement>('[data-field="newIconFile"]')?.click();
  });
  drawer.querySelector<HTMLInputElement>('[data-field="newIconFile"]')?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) void handleNewIconUpload(file);
  });
  drawer.querySelector('[data-action="add-custom-button"]')?.addEventListener('click', () => {
    void handleAddCustomButton(drawer);
  });
  drawer.querySelector('[data-action="reset-all"]')?.addEventListener('click', () => {
    if (confirm('Reset every customization? This clears all renames, hides, and icons.')) {
      void clearAllCustomizations();
    }
  });
  drawer.querySelector('[data-action="reset-element"]')?.addEventListener('click', () => {
    if (!selectedId) return;
    void removeEntry(selectedId);
  });
  drawer.querySelector('[data-action="delete-custom-button"]')?.addEventListener('click', () => {
    if (!selectedId?.startsWith('leftnav::custom-button-')) return;
    const id = selectedId.replace('leftnav::custom-button-', '');
    selectedId = null;
    void removeCustomButton(id);
  });

  drawer.querySelector('[data-action="icon-upload"]')?.addEventListener('click', () => {
    drawer.querySelector<HTMLInputElement>('[data-field="iconFile"]')?.click();
  });
  drawer.querySelector('[data-action="icon-color-toggle"]')?.addEventListener('click', () => {
    if (!selectedId) return;
    iconColorToolsForId = iconColorToolsForId === selectedId ? null : selectedId;
    renderDrawer();
  });
  drawer.querySelector('[data-action="icon-color-apply"]')?.addEventListener('click', () => {
    const color = drawer.querySelector<HTMLInputElement>('[data-field="iconColor"]')?.value;
    if (color) void tintSelectedIcon(color);
  });
  drawer.querySelector<HTMLInputElement>('[data-field="iconColor"]')?.addEventListener('change', (e) => {
    const color = (e.target as HTMLInputElement).value;
    if (color) void tintSelectedIcon(color);
  });
  drawer.querySelector('[data-action="icon-color-eyedropper"]')?.addEventListener('click', () => {
    void pickIconColorFromScreen();
  });
  drawer.querySelector<HTMLInputElement>('[data-field="iconFile"]')?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) void handleIconUpload(file);
  });
  drawer.querySelector('[data-action="icon-clear"]')?.addEventListener('click', () => {
    if (!selectedId) return;
    iconColorToolsForId = null;
    if (selectedId.startsWith('leftnav::custom-button-')) {
      void updateCustomButton(selectedId.replace('leftnav::custom-button-', ''), {
        iconDataUrl: undefined,
        iconPreset: undefined,
      });
    }
    void writeEdit({ iconDataUrl: undefined, iconPreset: undefined });
  });

  const textInput = drawer.querySelector<HTMLInputElement>('[data-field="text"]');
  textInput?.addEventListener('input', () => {
    void writeEdit({ text: textInput.value.trim() });
  });
  const hiddenInput = drawer.querySelector<HTMLInputElement>('[data-field="hidden"]');
  hiddenInput?.addEventListener('change', () => {
    void writeEdit({ hidden: hiddenInput.checked });
  });
  const presetInput = drawer.querySelector<HTMLSelectElement>('[data-field="iconPreset"]');
  presetInput?.addEventListener('change', () => {
    void updateSelectedIconPreset(presetInput.value);
  });
  const urlInput = drawer.querySelector<HTMLInputElement>('[data-field="iconUrl"]');
  urlInput?.addEventListener('change', () => {
    void commitSelectedIcon({ iconDataUrl: urlInput.value.trim() || undefined, iconPreset: undefined });
  });
}

async function handleNewIconUpload(file: File): Promise<void> {
  try {
    pendingCustomIconDataUrl = await resizeImageToDataUrl(file, 32);
    renderDrawer();
  } catch (e) {
    console.warn('[SviBlox] Custom button icon upload failed', e);
  }
}

async function handleAddCustomButton(drawer: HTMLElement): Promise<void> {
  const label = drawer.querySelector<HTMLInputElement>('[data-field="newLabel"]')?.value.trim() ?? '';
  const rawUrl = drawer.querySelector<HTMLInputElement>('[data-field="newUrl"]')?.value.trim() ?? '';
  const iconUrl = drawer.querySelector<HTMLInputElement>('[data-field="newIconUrl"]')?.value.trim() ?? '';
  const iconPreset = drawer.querySelector<HTMLSelectElement>('[data-field="newIconPreset"]')?.value.trim() ?? '';
  const url = normalizeCustomUrl(rawUrl);
  if (!label || !url) return;
  const explicitIcon = pendingCustomIconDataUrl || iconUrl || undefined;
  const button = await addCustomButton({
    label,
    url,
    iconDataUrl: explicitIcon,
    iconPreset: explicitIcon ? undefined : iconPreset || undefined,
  });
  pendingCustomIconDataUrl = '';
  selectedId = `leftnav::custom-button-${button.id}`;
  renderDrawer();
}

function normalizeCustomUrl(raw: string): string {
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return `https://www.roblox.com${raw}`;
  return `https://${raw}`;
}

async function moveById(id: string, delta: -1 | 1): Promise<void> {
  const spec = await getCustomizations();
  const el = resolveById(id, spec.entries[id]?.fallbackSelector);
  if (!el) return;
  const siblings = getSiblingTargets(el);
  const index = siblings.findIndex((target) => target.id === id);
  const nextIndex = index + delta;
  if (index < 0 || nextIndex < 0 || nextIndex >= siblings.length) return;

  const ordered = siblings.map((target) => target.id);
  [ordered[index], ordered[nextIndex]] = [ordered[nextIndex], ordered[index]];

  const parent = el.parentElement;
  const other = siblings[nextIndex].el;
  if (parent) {
    if (delta < 0) parent.insertBefore(el, other);
    else parent.insertBefore(other, el);
  }
  await setLeftNavOrder(ordered);
  syncInlineOrderControls();
  renderDrawer();
}

async function writeEdit(patch: Partial<ElementEdit>): Promise<void> {
  if (!selectedId) return;
  const spec = await getCustomizations();
  const current = spec.entries[selectedId] ?? {};
  const next: ElementEdit = { ...current, ...patch };
  const el = resolveById(selectedId, current.fallbackSelector);
  if (el && !next.fallbackSelector) next.fallbackSelector = buildFallbackSelector(el);
  await setEntry(selectedId, next);
}

async function updateSelectedIconPreset(iconPreset: string): Promise<void> {
  if (!selectedId) return;
  if (selectedId.startsWith('leftnav::custom-button-')) {
    const id = selectedId.replace('leftnav::custom-button-', '');
    await updateCustomButton(id, { iconPreset: iconPreset || undefined, iconDataUrl: undefined });
    await writeEdit({ iconDataUrl: undefined, iconPreset: undefined });
  } else {
    await writeEdit({ iconPreset: iconPreset || undefined, iconDataUrl: undefined });
  }
  iconColorToolsForId = null;
  renderDrawer();
}

async function handleIconUpload(file: File): Promise<void> {
  try {
    const dataUrl = await resizeImageToDataUrl(file, 32);
    iconColorToolsForId = selectedId;
    await commitSelectedIcon({ iconDataUrl: dataUrl, iconPreset: undefined });
  } catch (e) {
    console.warn('[SviBlox] Customize icon upload failed', e);
  }
}

/**
 * Routes an icon patch to the right store for the current selection: for a
 * custom button the icon lives on the CustomButton record (so syncCustomButtons
 * picks it up); for a regular nav item it lives in entries[]. Without this
 * split, custom button icon edits would land in entries[] only and be ignored
 * by the applier (which skips applyIcon for custom buttons — they own their
 * icon state via syncCustomButtons).
 */
async function commitSelectedIcon(patch: { iconDataUrl?: string; iconPreset?: string }): Promise<void> {
  if (!selectedId) return;
  if (selectedId.startsWith('leftnav::custom-button-')) {
    const id = selectedId.replace('leftnav::custom-button-', '');
    await updateCustomButton(id, patch);
  } else {
    await writeEdit(patch);
  }
}

function getSelectedIconUrl(): string {
  if (!selectedId) return '';
  const spec = getCachedCustomizations();
  const editIcon = spec.entries[selectedId]?.iconDataUrl;
  const customIcon = customButtonForId(selectedId, spec)?.iconDataUrl;
  return editIcon || customIcon || '';
}

async function tintSelectedIcon(color: string): Promise<void> {
  const source = getSelectedIconUrl();
  if (!source) return;
  try {
    lastIconTintColor = color;
    const dataUrl = await tintIconToDataUrl(source, color, 32);
    await commitSelectedIcon({ iconDataUrl: dataUrl, iconPreset: undefined });
    iconColorToolsForId = selectedId;
    renderDrawer();
  } catch (e) {
    console.warn('[SviBlox] Customize icon color failed', e);
  }
}

async function pickIconColorFromScreen(): Promise<void> {
  const Picker = (window as EyeDropperWindow).EyeDropper;
  if (!Picker) return;
  try {
    const result = await new Picker().open();
    await tintSelectedIcon(result.sRGBHex);
  } catch (e) {
    // User cancellation throws; that's fine.
    if ((e as DOMException)?.name !== 'AbortError') {
      console.warn('[SviBlox] Icon color picker failed', e);
    }
  }
}

function tintIconToDataUrl(src: string, color: string, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!src.startsWith('data:') && !src.startsWith('blob:')) img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Canvas unavailable'));
        ctx.imageSmoothingQuality = 'high';
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(img, 0, 0, size, size);
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, size, size);
        ctx.globalCompositeOperation = 'source-over';
        resolve(canvas.toDataURL('image/png'));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = src;
  });
}

function resizeImageToDataUrl(file: File, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Canvas unavailable'));
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, size, size);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('Image load failed'));
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    body.${BODY_CLASS} .left-nav nav ul > li:hover,
    body.${BODY_CLASS} .left-nav ul > li:hover,
    body.${BODY_CLASS} .left-col-list > li:hover,
    body.${BODY_CLASS} .rbx-left-col > ul > li:hover {
      outline: 2px solid #4a90e2;
      outline-offset: -2px;
      cursor: crosshair;
      background: rgba(74, 144, 226, 0.14);
    }
    body.${BODY_CLASS} .bp-cust-inline-host {
      position: relative !important;
    }
    body.${BODY_CLASS} .bp-cust-inline-order {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      display: flex;
      gap: 4px;
      opacity: 0;
      pointer-events: none;
      z-index: 20;
      transition: opacity 100ms ease;
    }
    body.${BODY_CLASS} .bp-cust-inline-host:hover > .bp-cust-inline-order,
    body.${BODY_CLASS} .bp-cust-inline-order:focus-within {
      opacity: 1;
      pointer-events: auto;
    }
    body.${BODY_CLASS} .bp-cust-inline-order button {
      width: 24px;
      height: 24px;
      padding: 0;
      border: 1px solid rgba(255,255,255,0.22);
      border-radius: 4px;
      background: #1a1d24;
      color: #fff;
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      box-shadow: 0 2px 8px rgba(0,0,0,0.28);
    }
    body.${BODY_CLASS} .bp-cust-inline-order button:hover:not(:disabled) {
      background: #4a90e2;
      border-color: rgba(255,255,255,0.36);
    }
    body.${BODY_CLASS} .bp-cust-inline-order button:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }

    #${DRAWER_ID} {
      position: fixed;
      top: 0; right: 0; bottom: 0;
      width: 340px;
      z-index: 99999;
      background: #1a1d24;
      color: #fff;
      border-left: 1px solid rgba(255,255,255,0.08);
      box-shadow: -8px 0 24px rgba(0,0,0,0.4);
      display: flex; flex-direction: column;
      font-family: inherit;
    }
    #${DRAWER_ID} .bp-cust-drawer-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 16px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    #${DRAWER_ID} h2 { margin: 0; font-size: 18px; font-weight: 700; }
    #${DRAWER_ID} .bp-cust-drawer-body {
      flex: 1; overflow-y: auto;
      padding: 16px;
      display: flex; flex-direction: column; gap: 14px;
    }
    #${DRAWER_ID} .bp-cust-drawer-footer {
      padding: 12px 16px;
      border-top: 1px solid rgba(255,255,255,0.08);
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px;
    }
    #${DRAWER_ID} .bp-cust-counts { font-size: 11px; opacity: 0.6; }
    #${DRAWER_ID} .bp-cust-hint {
      font-size: 13px; line-height: 1.5; opacity: 0.85; margin: 0;
    }
    #${DRAWER_ID} .bp-cust-hint kbd {
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 3px; padding: 1px 5px; font-size: 11px;
    }
    #${DRAWER_ID} .bp-cust-preview {
      background: rgba(255,255,255,0.04);
      border-radius: 8px;
      padding: 10px 12px;
    }
    #${DRAWER_ID} .bp-cust-preview-label {
      font-size: 10px; text-transform: uppercase; opacity: 0.6;
      letter-spacing: 0.5px; margin-bottom: 2px;
    }
    #${DRAWER_ID} .bp-cust-preview-name { font-size: 14px; font-weight: 600; }
    #${DRAWER_ID} .bp-cust-field {
      display: flex; flex-direction: column; gap: 4px;
      font-size: 12px;
    }
    #${DRAWER_ID} .bp-cust-field-inline {
      flex-direction: row; align-items: center;
    }
    #${DRAWER_ID} .bp-cust-field > span { opacity: 0.75; }
    #${DRAWER_ID} input[type="text"],
    #${DRAWER_ID} input[type="url"] {
      background: #0e1015; color: #fff;
      border: 1px solid rgba(255,255,255,0.16);
      border-radius: 4px;
      padding: 6px 8px; font-size: 13px;
      width: 100%; box-sizing: border-box;
    }
    #${DRAWER_ID} input[type="text"]:focus,
    #${DRAWER_ID} input[type="url"]:focus {
      outline: none; border-color: #4a90e2;
    }
    #${DRAWER_ID} .bp-cust-icon-group,
    #${DRAWER_ID} .bp-cust-position-group {
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px; padding: 10px 12px;
      display: flex; flex-direction: column; gap: 8px;
    }
    #${DRAWER_ID} .bp-cust-icon-group legend,
    #${DRAWER_ID} .bp-cust-position-group legend {
      font-size: 11px; text-transform: uppercase;
      opacity: 0.6; letter-spacing: 0.5px;
      padding: 0 4px;
    }
    #${DRAWER_ID} .bp-cust-position-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    #${DRAWER_ID} .bp-cust-icon-row {
      display: flex; align-items: center; gap: 10px;
    }
    #${DRAWER_ID} .bp-cust-icon-preview {
      width: 48px; height: 48px; border-radius: 6px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      padding: 0;
      color: inherit;
      display: flex; align-items: center; justify-content: center;
      overflow: hidden;
      flex-shrink: 0;
      cursor: pointer;
    }
    #${DRAWER_ID} .bp-cust-icon-preview:hover:not(:disabled) {
      border-color: #4a90e2;
      background: rgba(74,144,226,0.14);
    }
    #${DRAWER_ID} .bp-cust-icon-preview:disabled {
      cursor: default;
    }
    #${DRAWER_ID} .bp-cust-icon-preview img {
      width: 100%; height: 100%; object-fit: contain;
    }
    #${DRAWER_ID} .bp-cust-icon-placeholder {
      font-size: 10px; opacity: 0.5;
    }
    #${DRAWER_ID} .bp-cust-icon-actions {
      flex: 1; display: flex; flex-direction: column; gap: 6px;
    }
    #${DRAWER_ID} .bp-cust-icon-color-popover {
      display: grid;
      grid-template-columns: 42px 1fr 1fr;
      gap: 6px;
      align-items: center;
      padding: 8px;
      border: 1px solid rgba(74,144,226,0.28);
      border-radius: 6px;
      background: rgba(74,144,226,0.10);
    }
    #${DRAWER_ID} input[type="color"] {
      width: 42px;
      height: 32px;
      padding: 2px;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 4px;
      background: rgba(0,0,0,0.2);
      cursor: pointer;
    }
    #${DRAWER_ID} .bp-cust-btn {
      padding: 6px 12px; font-size: 12px;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.18);
      background: rgba(255,255,255,0.06); color: #fff;
      cursor: pointer; font-family: inherit;
    }
    #${DRAWER_ID} .bp-cust-btn:hover:not(:disabled) {
      background: rgba(255,255,255,0.12);
    }
    #${DRAWER_ID} .bp-cust-btn:disabled {
      opacity: 0.4; cursor: not-allowed;
    }
    #${DRAWER_ID} .bp-cust-btn-ghost { background: transparent; }
    #${DRAWER_ID} .bp-cust-btn-danger {
      border-color: rgba(217, 83, 79, 0.5);
      color: #ff8a85;
    }
    #${DRAWER_ID} .bp-cust-btn-danger:hover:not(:disabled) {
      background: rgba(217, 83, 79, 0.16);
    }
    #${DRAWER_ID} .bp-cust-actions {
      display: flex; gap: 8px; margin-top: 4px;
    }

    #${DRAWER_ID} .bp-cust-list-section {
      display: flex; flex-direction: column; gap: 8px;
      padding-bottom: 14px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    #${DRAWER_ID} .bp-cust-add-section {
      display: flex; flex-direction: column; gap: 8px;
      padding-bottom: 14px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    #${DRAWER_ID} .bp-cust-add-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    #${DRAWER_ID} .bp-cust-upload-ready {
      font-size: 11px;
      color: #86efac;
    }
    #${DRAWER_ID} .bp-cust-list-heading {
      font-size: 10px; text-transform: uppercase;
      opacity: 0.6; letter-spacing: 0.5px; margin: 0;
    }
    #${DRAWER_ID} .bp-cust-list {
      display: flex; flex-direction: column; gap: 4px;
    }
    #${DRAWER_ID} .bp-cust-list-group {
      margin: 8px 2px 2px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      opacity: 0.84;
    }
    #${DRAWER_ID} .bp-cust-list-group-hidden { color: #ffb56b; }
    #${DRAWER_ID} .bp-cust-list-group-renamed { color: #ffe08a; }
    #${DRAWER_ID} .bp-cust-list-group-icon { color: #99f6e4; }
    #${DRAWER_ID} .bp-cust-list-group-custom { color: #b9ddff; }
    #${DRAWER_ID} .bp-cust-list-item {
      display: flex; align-items: stretch;
      background: rgba(255,255,255,0.04);
      border-radius: 6px; overflow: hidden;
      border-left: 3px solid transparent;
    }
    #${DRAWER_ID} .bp-cust-list-item-active {
      border-left-color: #4a90e2;
      background: rgba(74,144,226,0.14);
    }
    #${DRAWER_ID} .bp-cust-list-item-missing { opacity: 0.5; }
    #${DRAWER_ID} .bp-cust-list-select {
      flex: 1; display: flex; align-items: center; justify-content: space-between;
      gap: 8px;
      padding: 8px 10px;
      background: transparent;
      border: none; color: inherit; font: inherit;
      cursor: pointer; text-align: left; min-width: 0;
    }
    #${DRAWER_ID} .bp-cust-list-select:hover { background: rgba(255,255,255,0.06); }
    #${DRAWER_ID} .bp-cust-list-name {
      font-size: 13px; font-weight: 600;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      flex: 1; min-width: 0;
    }
    #${DRAWER_ID} .bp-cust-missing-tag { font-style: italic; font-weight: 400; opacity: 0.8; font-size: 11px; }
    #${DRAWER_ID} .bp-cust-list-chips {
      display: flex; gap: 4px; flex-shrink: 0;
    }
    #${DRAWER_ID} .bp-cust-chip {
      font-size: 10px; padding: 2px 6px; border-radius: 999px;
      font-weight: 600;
    }
    #${DRAWER_ID} .bp-cust-chip-custom {
      background: rgba(74,144,226,0.22);
      color: #b9ddff;
    }
    #${DRAWER_ID} .bp-cust-chip-renamed {
      background: rgba(245, 190, 65, 0.22);
      color: #ffe08a;
    }
    #${DRAWER_ID} .bp-cust-chip-hidden {
      background: rgba(245, 130, 49, 0.22);
      color: #ffb56b;
    }
    #${DRAWER_ID} .bp-cust-chip-icon {
      background: rgba(45, 212, 191, 0.20);
      color: #99f6e4;
    }
    #${DRAWER_ID} .bp-cust-list-remove {
      width: 28px; flex-shrink: 0;
      background: transparent; border: none; color: rgba(255,255,255,0.4);
      cursor: pointer; font-size: 16px; line-height: 1;
      border-left: 1px solid rgba(255,255,255,0.06);
    }
    #${DRAWER_ID} .bp-cust-list-remove:hover {
      background: rgba(217, 83, 79, 0.18); color: #ff8a85;
    }

    /* Brief flash on the live nav item when its row is clicked in the list. */
    .bp-cust-flash {
      animation: bp-cust-flash 0.6s ease-out;
    }
    @keyframes bp-cust-flash {
      0%   { box-shadow: 0 0 0 2px #4a90e2, 0 0 12px 4px rgba(74,144,226,0.55); }
      100% { box-shadow: 0 0 0 0 transparent, 0 0 0 0 transparent; }
    }

    @media (max-width: 1100px) {
      #${DRAWER_ID} { width: 280px; }
    }
  `;
  document.head.appendChild(style);
}
