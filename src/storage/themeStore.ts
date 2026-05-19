import { CustomTheme, UserThemeEntry } from '@/types';
import { getSettings, setSettings } from './settingsStore';

const LEGACY_KEY = 'bloxplus.customTheme';
const LIST_KEY = 'bloxplus.userThemes';

interface UserThemesState {
  /** id → entry. */
  entries: Record<string, UserThemeEntry>;
  /** Insertion / display order. First entry is always `custom`. */
  order: string[];
}

const EMPTY_STATE: UserThemesState = { entries: {}, order: [] };

/**
 * One-shot migration from the legacy single-slot `bloxplus.customTheme` key
 * into the multi-preset `bloxplus.userThemes` list as id `custom` /
 * "Custom #1". Idempotent — once `userThemes` exists, the legacy key is
 * ignored (but not deleted; older builds may still read it).
 */
async function migrateIfNeeded(): Promise<UserThemesState> {
  const r = await chrome.storage.local.get([LIST_KEY, LEGACY_KEY]);
  const existing = r[LIST_KEY] as UserThemesState | undefined;
  if (existing && existing.entries) return existing;

  const legacy = r[LEGACY_KEY] as CustomTheme | undefined;
  const state: UserThemesState = { entries: {}, order: [] };
  if (legacy && Object.keys(legacy).length > 0) {
    state.entries['custom'] = { id: 'custom', name: 'Custom #1', theme: legacy };
    state.order = ['custom'];
  }
  await chrome.storage.local.set({ [LIST_KEY]: state });
  return state;
}

export async function getUserThemes(): Promise<UserThemesState> {
  return await migrateIfNeeded();
}

async function writeUserThemes(state: UserThemesState): Promise<void> {
  await chrome.storage.local.set({ [LIST_KEY]: state });
}

export async function getUserTheme(id: string): Promise<UserThemeEntry | null> {
  const state = await getUserThemes();
  return state.entries[id] ?? null;
}

/**
 * Returns the CustomTheme payload of whichever user preset is currently
 * active (per `settings.themeId`). Returns `{}` when the active theme is a
 * built-in preset or no user preset exists by that id.
 *
 * This is the function `themeInjector.applyCurrent()` calls; the rest of the
 * legacy "single custom theme" API below is implemented in terms of it.
 */
export async function getCustomTheme(): Promise<CustomTheme> {
  const [settings, state] = await Promise.all([getSettings(), getUserThemes()]);
  const entry = state.entries[settings.themeId];
  return entry ? entry.theme : {};
}

/**
 * Patch the active user theme's payload. If the active theme is a built-in
 * preset (e.g. `default`, `classic-2016`), this is a no-op — callers must
 * route through `createUserTheme` first.
 */
export async function setCustomTheme(patch: Partial<CustomTheme>): Promise<CustomTheme> {
  const settings = await getSettings();
  const state = await getUserThemes();
  const entry = state.entries[settings.themeId];
  if (!entry) return {};
  const next: CustomTheme = { ...entry.theme, ...patch };
  state.entries[settings.themeId] = { ...entry, theme: next };
  await writeUserThemes(state);
  return next;
}

export async function setCustomThemeBackground(backgroundImage: string): Promise<CustomTheme> {
  return setCustomTheme({ backgroundImage });
}

export async function removeCustomThemeBackground(): Promise<CustomTheme> {
  const settings = await getSettings();
  const state = await getUserThemes();
  const entry = state.entries[settings.themeId];
  if (!entry) return {};
  const next: CustomTheme = { ...entry.theme };
  delete next.backgroundImage;
  state.entries[settings.themeId] = { ...entry, theme: next };
  await writeUserThemes(state);
  return next;
}

/**
 * Wipes the active user theme back to an empty palette. Does NOT remove the
 * entry from the list (the user-preset tile remains so the slot is still
 * targetable).
 */
export async function clearCustomTheme(): Promise<void> {
  const settings = await getSettings();
  const state = await getUserThemes();
  const entry = state.entries[settings.themeId];
  if (!entry) return;
  state.entries[settings.themeId] = { ...entry, theme: {} };
  await writeUserThemes(state);
}

// ── Multi-preset management ────────────────────────────────────────────────

/**
 * Suggests the next available id and a matching default name. The id is
 * stable for storage (`custom`, `custom-2`, …); the name is just a label
 * shown in the UI ("Custom #1", "Custom #2", …) and is user-editable.
 */
export function suggestNextUserTheme(state: UserThemesState): { id: string; name: string } {
  let n = 1;
  while (state.entries[n === 1 ? 'custom' : `custom-${n}`]) n++;
  return {
    id: n === 1 ? 'custom' : `custom-${n}`,
    name: `Custom #${n}`,
  };
}

/**
 * Creates a new user preset and writes it to storage. Does not activate it —
 * callers should `setSettings({ themeId: id })` separately if they want that.
 */
export async function createUserTheme(
  name: string,
  theme: CustomTheme
): Promise<UserThemeEntry> {
  const state = await getUserThemes();
  const { id } = suggestNextUserTheme(state);
  const entry: UserThemeEntry = { id, name: name.trim() || id, theme };
  state.entries[id] = entry;
  state.order.push(id);
  await writeUserThemes(state);
  return entry;
}

export async function renameUserTheme(id: string, name: string): Promise<void> {
  const state = await getUserThemes();
  const entry = state.entries[id];
  if (!entry) return;
  state.entries[id] = { ...entry, name: name.trim() || entry.name };
  await writeUserThemes(state);
}

/**
 * Deletes the user preset. If it was the active theme, the caller is
 * responsible for switching `settings.themeId` to a sensible fallback —
 * `deleteUserTheme` handles that by reverting to `'default'` when it has to.
 */
export async function deleteUserTheme(id: string): Promise<void> {
  const state = await getUserThemes();
  if (!state.entries[id]) return;
  delete state.entries[id];
  state.order = state.order.filter((x) => x !== id);
  await writeUserThemes(state);
  const settings = await getSettings();
  if (settings.themeId === id) {
    await setSettings({ themeId: 'default' });
  }
}

/**
 * Overwrites a user preset's theme payload (used by the Apply → Overwrite
 * prompt). Unlike `setCustomTheme`, the target id is explicit rather than
 * derived from `settings.themeId`, so this works while the user is editing
 * a draft on a different active theme.
 */
export async function overwriteUserTheme(
  id: string,
  theme: CustomTheme
): Promise<void> {
  const state = await getUserThemes();
  const entry = state.entries[id];
  if (!entry) return;
  state.entries[id] = { ...entry, theme };
  await writeUserThemes(state);
}

// ── Change listeners ──────────────────────────────────────────────────────

export function onCustomThemeChanged(cb: (t: CustomTheme) => void): void {
  // Active-theme payload — fires whenever the list changes, since any update
  // could affect the active entry. Resolves the active entry lazily so the
  // callback always sees what's now in storage.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes[LIST_KEY] && !changes[LEGACY_KEY]) return;
    void getCustomTheme().then(cb);
  });
}

export function onUserThemesChanged(cb: (state: UserThemesState) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[LIST_KEY]) {
      cb((changes[LIST_KEY].newValue as UserThemesState | undefined) ?? EMPTY_STATE);
    }
  });
}
