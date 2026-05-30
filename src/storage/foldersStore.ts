/**
 * Storage for user-defined Game Folders. Folders contain Roblox universeIds
 * and an optional rootPlaceId (cached for tile rendering when we can't hit
 * the games endpoint right away). Lives in chrome.storage.local so it
 * survives reloads and doesn't fight chrome.storage.sync's 8 KB per-item
 * limit if the user accumulates a large library.
 */

const KEY = 'bloxplus.folders';

export interface FolderGame {
  universeId: number;
  placeId?: number;
  name?: string;
}

export interface Folder {
  id: string;
  name: string;
  games: FolderGame[];
  createdAt: string;
}

export type FolderGamesSort = 'most-active' | 'least-active' | 'random';

export interface FoldersState {
  folders: Folder[];
  selectedFolderId: string | null;
  /** Sort/filter used by the main home-page folder row. */
  mainRowSort?: FolderGamesSort;
  /**
   * Folder ids for additional home-page folder rows below the main one. The
   * main row uses `selectedFolderId`; each entry here is one extra row that
   * independently picks a folder to display. An empty string means "no folder
   * picked yet" for that row. Absent on legacy state (treated as no extra rows).
   */
  extraRows?: string[];
  /** Sort/filter per extra row, aligned by index with `extraRows`. */
  extraRowSorts?: FolderGamesSort[];
}

const EMPTY: FoldersState = { folders: [], selectedFolderId: null };

export async function getFolders(): Promise<FoldersState> {
  const r = await chrome.storage.local.get(KEY);
  const v = r[KEY] as FoldersState | undefined;
  if (!v || !Array.isArray(v.folders)) return { ...EMPTY };
  return v;
}

async function setFolders(state: FoldersState): Promise<void> {
  await chrome.storage.local.set({ [KEY]: state });
}

export async function createFolder(name: string): Promise<Folder> {
  const trimmed = name.trim().slice(0, 60);
  const state = await getFolders();
  const folder: Folder = {
    id: makeId(),
    name: trimmed || 'New folder',
    games: [],
    createdAt: new Date().toISOString(),
  };
  state.folders.push(folder);
  state.selectedFolderId = folder.id;
  await setFolders(state);
  return folder;
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const state = await getFolders();
  const f = state.folders.find((x) => x.id === id);
  if (!f) return;
  f.name = name.trim().slice(0, 60) || f.name;
  await setFolders(state);
}

export async function deleteFolder(id: string): Promise<void> {
  const state = await getFolders();
  state.folders = state.folders.filter((x) => x.id !== id);
  if (state.selectedFolderId === id) state.selectedFolderId = state.folders[0]?.id ?? null;
  // Any extra row pointing at the deleted folder resets to "no folder picked"
  // rather than vanishing, so the user's row count is preserved.
  if (state.extraRows) state.extraRows = state.extraRows.map((rid) => (rid === id ? '' : rid));
  await setFolders(state);
}

/** Appends an extra folder row (below the main one). */
export async function addFolderRow(
  folderId: string | null = null,
  sort: FolderGamesSort = 'most-active'
): Promise<void> {
  const state = await getFolders();
  state.extraRows = [...(state.extraRows ?? []), folderId ?? ''];
  state.extraRowSorts = [...(state.extraRowSorts ?? []), sort];
  await setFolders(state);
}

/** Removes the extra folder row at `index` (does not delete the folder). */
export async function removeFolderRow(index: number): Promise<void> {
  const state = await getFolders();
  if (!state.extraRows || index < 0 || index >= state.extraRows.length) return;
  state.extraRows = state.extraRows.filter((_, i) => i !== index);
  if (state.extraRowSorts) state.extraRowSorts = state.extraRowSorts.filter((_, i) => i !== index);
  await setFolders(state);
}

/** Sets which folder the extra row at `index` displays. */
export async function setFolderRow(index: number, folderId: string): Promise<void> {
  const state = await getFolders();
  if (!state.extraRows || index < 0 || index >= state.extraRows.length) return;
  const rows = [...state.extraRows];
  rows[index] = folderId;
  state.extraRows = rows;
  await setFolders(state);
}

export async function setMainRowSort(sort: FolderGamesSort): Promise<void> {
  const state = await getFolders();
  state.mainRowSort = sort;
  await setFolders(state);
}

export async function setFolderRowSort(index: number, sort: FolderGamesSort): Promise<void> {
  const state = await getFolders();
  if (!state.extraRows || index < 0 || index >= state.extraRows.length) return;
  const sorts = state.extraRowSorts ? [...state.extraRowSorts] : [];
  sorts[index] = sort;
  state.extraRowSorts = sorts;
  await setFolders(state);
}

export async function selectFolder(id: string | null): Promise<void> {
  const state = await getFolders();
  state.selectedFolderId = id;
  await setFolders(state);
}

export async function addGameToFolder(folderId: string, game: FolderGame): Promise<void> {
  const state = await getFolders();
  const f = state.folders.find((x) => x.id === folderId);
  if (!f) return;
  if (f.games.some((g) => g.universeId === game.universeId)) return;
  f.games.push(game);
  await setFolders(state);
}

export async function removeGameFromFolder(folderId: string, universeId: number): Promise<void> {
  const state = await getFolders();
  const f = state.folders.find((x) => x.id === folderId);
  if (!f) return;
  f.games = f.games.filter((g) => g.universeId !== universeId);
  await setFolders(state);
}

export function onFoldersChanged(cb: (state: FoldersState) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== 'local' || !changes[KEY]) return;
    const v = changes[KEY].newValue as FoldersState | undefined;
    cb(v && Array.isArray(v.folders) ? v : { ...EMPTY });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `f_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeSelectedFolder(state: FoldersState): string | null {
  return state.selectedFolderId && state.folders.some((f) => f.id === state.selectedFolderId)
    ? state.selectedFolderId
    : state.folders[0]?.id ?? null;
}
