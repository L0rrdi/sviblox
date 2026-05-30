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

export interface FoldersState {
  folders: Folder[];
  selectedFolderId: string | null;
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
