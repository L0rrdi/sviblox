/**
 * Persistent storage for SviBlox's customize-mode edits to Roblox nav/header
 * items. Lives in `chrome.storage.local` (per-element data URLs for custom
 * icons can be a few KB each — extension has `unlimitedStorage`).
 *
 * Schema:
 *   { version: 1, entries: { [stableId]: ElementEdit }, leftNavOrder?: string[], customButtons?: CustomButton[] }
 *
 * Stable ids are computed by `customizeIdentity.customId` from a target's
 * surface + (anchor href || trimmed text). Edits with no fields set are
 * treated as "no edit" and stripped on write.
 */

const KEY = 'bloxplus.customizations';

export interface ElementEdit {
  hidden?: boolean;
  text?: string;
  /**
   * Either a `data:image/...` URL (from a file upload) or an external image
   * URL. The applier writes this as the `src` of an `<img>` inside the
   * target's icon slot; the browser handles loading either form.
   */
  iconDataUrl?: string;
  /**
   * Pre-tint copy of the uploaded icon. Set at upload/paste time alongside
   * `iconDataUrl`; the tint pipeline then overwrites `iconDataUrl` while
   * leaving this untouched, so users can revert the recolor via a single
   * click without re-uploading. Cleared when icon is cleared.
   */
  originalIconDataUrl?: string;
  /** Built-in animated icon preset id, rendered as inline SVG by the applier. */
  iconPreset?: string;
  /**
   * Last-known selector for the element. Used as a crash-recovery fallback
   * when `customId` can't relocate the target after a Roblox redesign.
   */
  fallbackSelector?: string;
}

export interface CustomButton {
  id: string;
  label: string;
  url: string;
  iconDataUrl?: string;
  /** See ElementEdit.originalIconDataUrl. */
  originalIconDataUrl?: string;
  iconPreset?: string;
}

export interface CustomizationSpec {
  version: 1;
  entries: Record<string, ElementEdit>;
  /** Stable ids in the user's preferred left-nav order. Missing/new ids append in DOM order. */
  leftNavOrder?: string[];
  customButtons?: CustomButton[];
}

const EMPTY: CustomizationSpec = { version: 1, entries: {} };

let cache: CustomizationSpec | null = null;

export async function getCustomizations(): Promise<CustomizationSpec> {
  if (cache) return cache;
  const r = await chrome.storage.local.get(KEY);
  const v = r[KEY] as CustomizationSpec | undefined;
  const initial = v && v.version === 1 && v.entries ? v : { ...EMPTY, entries: {} };
  cache = migrateCustomButtonIcons(initial);
  return cache;
}

/**
 * One-time migration: earlier versions of the customize editor wrote icon
 * uploads/recolors for custom buttons to `entries[customButtonId]` instead of
 * to `customButtons[i]`. With the applier now skipping `applyIcon` for custom
 * buttons (icons are owned by syncCustomButtons), those legacy icons would
 * silently disappear. Move them onto the CustomButton record and strip the
 * orphan entries, persisting the cleanup.
 */
function migrateCustomButtonIcons(spec: CustomizationSpec): CustomizationSpec {
  const buttons = spec.customButtons;
  if (!buttons?.length) return spec;
  let dirty = false;
  const nextEntries: Record<string, ElementEdit> = { ...spec.entries };
  const nextButtons = buttons.map((button) => {
    const stableId = `leftnav::custom-button-${button.id}`;
    const orphan = nextEntries[stableId];
    if (!orphan) return button;
    let updated = button;
    const hasIconOrphan = Boolean(orphan.iconDataUrl || orphan.iconPreset);
    if (!updated.iconDataUrl && !updated.iconPreset && hasIconOrphan) {
      updated = { ...updated, iconDataUrl: orphan.iconDataUrl, iconPreset: orphan.iconPreset };
      dirty = true;
    }
    if (hasIconOrphan) {
      const cleaned: ElementEdit = { ...orphan };
      delete cleaned.iconDataUrl;
      delete cleaned.iconPreset;
      if (Object.keys(cleaned).length === 0) {
        delete nextEntries[stableId];
      } else {
        nextEntries[stableId] = cleaned;
      }
      dirty = true;
    }
    return updated;
  });
  if (!dirty) return spec;
  const migrated: CustomizationSpec = { ...spec, entries: nextEntries, customButtons: nextButtons };
  void chrome.storage.local.set({ [KEY]: migrated });
  return migrated;
}

/**
 * Synchronous read of the in-memory cache. Returns the empty spec if the
 * store hasn't been hydrated yet — callers in the applier loop should ensure
 * `getCustomizations()` has been awaited at module init.
 */
export function getCachedCustomizations(): CustomizationSpec {
  return cache ?? { ...EMPTY, entries: {} };
}

/**
 * Overwrites the entry for `id` with `edit`. Empty / falsey fields are
 * stripped; if no fields survive, the entry is dropped entirely.
 */
export async function setEntry(id: string, edit: ElementEdit): Promise<void> {
  const cleaned: ElementEdit = {};
  for (const [k, v] of Object.entries(edit)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    (cleaned as Record<string, unknown>)[k] = v;
  }
  const spec = await getCustomizations();
  const next: CustomizationSpec = { ...spec, entries: { ...spec.entries } };
  if (Object.keys(cleaned).length === 0) {
    delete next.entries[id];
  } else {
    next.entries[id] = cleaned;
  }
  cache = next;
  await chrome.storage.local.set({ [KEY]: next });
}

export async function setLeftNavOrder(order: string[]): Promise<void> {
  const spec = await getCustomizations();
  const unique = [...new Set(order)].filter(Boolean);
  const next: CustomizationSpec = {
    ...spec,
    entries: { ...spec.entries },
    leftNavOrder: unique.length ? unique : undefined,
  };
  cache = next;
  await chrome.storage.local.set({ [KEY]: next });
}

export async function addCustomButton(button: Omit<CustomButton, 'id'>): Promise<CustomButton> {
  const spec = await getCustomizations();
  const nextButton: CustomButton = {
    ...button,
    id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
  const next: CustomizationSpec = {
    ...spec,
    entries: { ...spec.entries },
    customButtons: [...(spec.customButtons ?? []), nextButton],
  };
  cache = next;
  await chrome.storage.local.set({ [KEY]: next });
  return nextButton;
}

export async function updateCustomButton(id: string, patch: Partial<Omit<CustomButton, 'id'>>): Promise<void> {
  const spec = await getCustomizations();
  const customButtons = (spec.customButtons ?? []).map((button) => {
    if (button.id !== id) return button;
    const nextButton: CustomButton = { ...button, ...patch };
    for (const [k, v] of Object.entries(nextButton)) {
      if (k === 'id') continue;
      if (v === undefined || v === null || v === '') delete (nextButton as unknown as Record<string, unknown>)[k];
    }
    return nextButton;
  });
  const next: CustomizationSpec = {
    ...spec,
    entries: { ...spec.entries },
    customButtons: customButtons.length ? customButtons : undefined,
  };
  cache = next;
  await chrome.storage.local.set({ [KEY]: next });
}

export async function removeCustomButton(id: string): Promise<void> {
  const spec = await getCustomizations();
  const customButtons = (spec.customButtons ?? []).filter((button) => button.id !== id);
  const stableId = `leftnav::custom-button-${id}`;
  const nextEntries = { ...spec.entries };
  delete nextEntries[stableId];
  const next: CustomizationSpec = {
    ...spec,
    entries: nextEntries,
    leftNavOrder: spec.leftNavOrder?.filter((x) => x !== stableId),
    customButtons: customButtons.length ? customButtons : undefined,
  };
  cache = next;
  await chrome.storage.local.set({ [KEY]: next });
}

export async function removeEntry(id: string): Promise<void> {
  const spec = await getCustomizations();
  if (!spec.entries[id]) return;
  const next: CustomizationSpec = { ...spec, entries: { ...spec.entries } };
  delete next.entries[id];
  cache = next;
  await chrome.storage.local.set({ [KEY]: next });
}

export async function clearAllCustomizations(): Promise<void> {
  cache = { ...EMPTY, entries: {} };
  await chrome.storage.local.set({ [KEY]: cache });
}

/**
 * Restore a full spec snapshot — used by the "Undo" affordance after a
 * Reset all. Skips the empty-strip pass since the snapshot has already been
 * validated by virtue of having come out of storage.
 */
export async function restoreSpec(spec: CustomizationSpec): Promise<void> {
  const next: CustomizationSpec = {
    version: 1,
    entries: { ...spec.entries },
    leftNavOrder: spec.leftNavOrder,
    customButtons: spec.customButtons,
  };
  cache = next;
  await chrome.storage.local.set({ [KEY]: next });
}

export function onCustomizationsChanged(cb: (s: CustomizationSpec) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    const v = changes[KEY].newValue as CustomizationSpec | undefined;
    cache = v && v.version === 1 && v.entries ? v : { ...EMPTY, entries: {} };
    cb(cache);
  });
}
