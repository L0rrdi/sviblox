import { getGameInfo, getGameVotes, GameInfo, GameVote } from '@/api/games';
import { getGameIcons } from '@/api/thumbnails';
import { getSettings } from '@/storage/settingsStore';
import {
  getFolders,
  onFoldersChanged,
  selectFolder,
  createFolder,
  renameFolder,
  deleteFolder,
  removeGameFromFolder,
  normalizeSelectedFolder,
  FoldersState,
  Folder,
} from '@/storage/foldersStore';
import { Settings } from '@/types';
import { escapeHtml } from '@/util/html';
import {
  ensureFavoritesStyle,
  ensureHomeListScroller,
  gameHref,
  gameStatsHtml,
} from './favoritesSection';

export const FOLDERS_SECTION_ID = 'bloxplus-folders-section';
const FOLDERS_STYLE_ID = 'bloxplus-folders-style';

let foldersSubscribed = false;
let lastFoldersState: FoldersState | null = null;
let lastRenderedFolderSignature: string | null = null;
let foldersRenderSeq = 0;
// Module-level flag because the random pick must fire ONCE per page load,
// not every observer tick. Resets naturally when the page is reloaded.
let randomPickHandled = false;

// Kick off the folders read at module load so `lastFoldersState` is usually
// populated by the time `ensureFoldersSection` builds the DOM. Without this,
// the section briefly renders with no data and the label flashes "No folders
// yet" even when folders exist. Also subscribe to changes here so updates
// fired before the section is mounted aren't missed.
void getFolders().then((state) => {
  lastFoldersState = state;
  const sec = document.getElementById(FOLDERS_SECTION_ID);
  if (sec instanceof HTMLElement) void renderFoldersSection(sec, state);
});
if (!foldersSubscribed) {
  foldersSubscribed = true;
  onFoldersChanged((state) => {
    lastFoldersState = state;
    const sec = document.getElementById(FOLDERS_SECTION_ID);
    if (sec instanceof HTMLElement) void renderFoldersSection(sec, state);
  });
}

export function ensureFoldersSection(): HTMLElement {
  ensureFavoritesStyle();
  ensureFoldersStyle();

  let section = document.getElementById(FOLDERS_SECTION_ID);
  if (!section) {
    section = document.createElement('div');
    section.id = FOLDERS_SECTION_ID;
    section.innerHTML = `
      <div class="bp-fav-header">
        <h2>Folders</h2>
        <div class="bp-fav-header-actions">
          <div class="bp-folder-picker">
            <button type="button" class="bp-folder-picker-trigger" data-folder-picker>
              <span class="bp-folder-picker-label"></span>
              <span class="bp-folder-picker-caret">▾</span>
            </button>
          </div>
          <button type="button" class="bp-folder-action" data-folder-action="new"
                  title="New folder">＋</button>
          <button type="button" class="bp-folder-action" data-folder-action="rename"
                  title="Rename folder">✎</button>
          <button type="button" class="bp-folder-action bp-folder-action-danger"
                  data-folder-action="delete" title="Delete folder">🗑</button>
        </div>
      </div>
      <ul class="bp-fav-row hlist games game-cards game-tile-list home-page-carousel"></ul>
    `;

    // Picker dropdown toggles a menu listing all folders.
    const trigger = section.querySelector<HTMLButtonElement>('[data-folder-picker]');
    trigger?.addEventListener('click', (e) => {
      e.stopPropagation();
      void toggleFolderPickerMenu(section!);
    });

    // Action buttons.
    section
      .querySelector<HTMLButtonElement>('[data-folder-action="new"]')
      ?.addEventListener('click', async () => {
        const name = window.prompt('New folder name')?.trim();
        if (!name) return;
        await createFolder(name);
      });
    section
      .querySelector<HTMLButtonElement>('[data-folder-action="rename"]')
      ?.addEventListener('click', async () => {
        const state = await getFolders();
        const cur = state.folders.find((f) => f.id === state.selectedFolderId);
        if (!cur) return;
        const next = window.prompt('Rename folder', cur.name)?.trim();
        if (!next || next === cur.name) return;
        await renameFolder(cur.id, next);
      });
    section
      .querySelector<HTMLButtonElement>('[data-folder-action="delete"]')
      ?.addEventListener('click', async () => {
        const state = await getFolders();
        const cur = state.folders.find((f) => f.id === state.selectedFolderId);
        if (!cur) return;
        const ok = window.confirm(`Delete folder "${cur.name}"? Games inside are not deleted from Roblox.`);
        if (!ok) return;
        await deleteFolder(cur.id);
      });
  }

  ensureHomeListScroller(section);

  // Module-level prefetch (above) usually has `lastFoldersState` ready. The
  // fallback path covers the rare case where this enhancer runs before that
  // promise resolves.
  if (lastFoldersState) {
    void renderFoldersSection(section, lastFoldersState);
  } else {
    void getFolders().then((state) => {
      lastFoldersState = state;
      void renderFoldersSection(section!, state);
    });
  }
  return section;
}

async function toggleFolderPickerMenu(section: HTMLElement): Promise<void> {
  const trigger = section.querySelector<HTMLElement>('[data-folder-picker]');
  if (!trigger) return;
  const existing = document.getElementById('bloxplus-folder-picker-menu');
  if (existing) { existing.remove(); return; }
  const state = await getFolders();

  const menu = document.createElement('div');
  menu.id = 'bloxplus-folder-picker-menu';
  menu.className = 'bp-folder-picker-menu';
  if (!state.folders.length) {
    menu.innerHTML = `<div class="bp-folder-picker-empty">No folders yet</div>`;
  } else {
    menu.innerHTML = state.folders
      .map(
        (f) =>
          `<button type="button" class="bp-folder-picker-item${
            f.id === state.selectedFolderId ? ' bp-folder-picker-item-active' : ''
          }" data-folder-id="${f.id}">
            <span class="bp-folder-picker-name">${escapeHtml(f.name)}</span>
            <span class="bp-folder-picker-count">${f.games.length}</span>
          </button>`
      )
      .join('');
  }
  document.body.appendChild(menu);
  const r = trigger.getBoundingClientRect();
  menu.style.left = `${Math.max(8, r.left)}px`;
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.minWidth = `${Math.max(180, r.width)}px`;

  for (const el of menu.querySelectorAll<HTMLButtonElement>('[data-folder-id]')) {
    el.addEventListener('click', async () => {
      await selectFolder(el.dataset.folderId!);
      menu.remove();
    });
  }
  const close = (e: MouseEvent) => {
    if (e.target instanceof Node && menu.contains(e.target)) return;
    menu.remove();
    document.removeEventListener('mousedown', close, true);
  };
  document.addEventListener('mousedown', close, true);
}

async function renderFoldersSection(section: HTMLElement, state: FoldersState): Promise<void> {
  const settings = await getSettings();

  // One-shot random folder pick on the first render after a page reload, when
  // the user picked the "Random folder each refresh" option. We update both
  // the local state we render with AND chrome.storage so the picker reflects
  // the choice; subsequent observer ticks short-circuit via randomPickHandled.
  if (
    !randomPickHandled &&
    settings.foldersFolderSelection === 'random' &&
    state.folders.length > 0
  ) {
    randomPickHandled = true;
    const candidates = state.folders.filter((f) => f.id !== state.selectedFolderId);
    const pool = candidates.length > 0 ? candidates : state.folders;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (pick && pick.id !== state.selectedFolderId) {
      state.selectedFolderId = pick.id;
      void selectFolder(pick.id);
    }
  } else if (settings.foldersFolderSelection === 'previous') {
    // Sticky-pick mode: nothing to do beyond honoring the stored selectedFolderId.
    randomPickHandled = true;
  }

  // If selection is invalid, snap to the first available folder and repair
  // storage. Keeping a dead selectedFolderId around makes later async render
  // guards think the visible folder is stale, which can leave the row blank.
  const selectedId = normalizeSelectedFolder(state);
  if (selectedId !== state.selectedFolderId) {
    state = { ...state, selectedFolderId: selectedId };
    lastFoldersState = state;
    void selectFolder(selectedId);
  }
  const folder = state.folders.find((f) => f.id === selectedId) ?? null;
  const row = section.querySelector<HTMLUListElement>('.bp-fav-row');
  if (!row) return;

  // Skip re-render when nothing visible has changed. ensureFoldersSection is
  // called on every mutation tick by the home reorder loop; without this
  // guard we'd wipe + replace the tile row on every page mutation. The sort
  // setting is part of the signature so toggling sort triggers a re-render
  // without changing the stored folder data. After returning from another
  // overlay (Themes/UHBL), Roblox can hand us the same section with an empty
  // row while the module-level signature still matches; force a repaint in
  // that case instead of trusting the cached signature.
  const signature = folderRenderSignature(
    state.folders,
    selectedId,
    settings.foldersGamesSort
  );
  if (signature === lastRenderedFolderSignature && folderRowMatchesSelection(row, folder, state.folders.length)) return;
  lastRenderedFolderSignature = signature;
  const renderSeq = ++foldersRenderSeq;

  // Header label + button enabled state.
  const label = section.querySelector<HTMLElement>('.bp-folder-picker-label');
  if (label) label.textContent = folder ? folder.name : state.folders.length ? 'Pick a folder' : 'No folders yet';
  for (const action of ['rename', 'delete'] as const) {
    const btn = section.querySelector<HTMLButtonElement>(`[data-folder-action="${action}"]`);
    if (btn) btn.disabled = !folder;
  }

  if (renderSeq !== foldersRenderSeq) return;

  if (!folder) {
    row.innerHTML = `<li class="bp-fav-empty">Create a folder, then add games from any game page.</li>`;
    return;
  }
  if (!folder.games.length) {
    row.innerHTML = `<li class="bp-fav-empty">No games in "${escapeHtml(folder.name)}" yet. Open a game and use the Folder button.</li>`;
    return;
  }

  // Render skeleton tiles first using cached folder info, then enrich with
  // live thumbnails / stats once the API responds.
  row.innerHTML = folder.games
    .map((g) =>
      folderTileHtml(g.universeId, {
        name: g.name ?? `Universe ${g.universeId}`,
        href: gameHref(g.placeId, g.universeId),
      })
    )
    .join('');

  const universeIds = folder.games.map((g) => g.universeId);
  let icons: Map<number, string> = new Map();
  let info: Map<number, GameInfo> = new Map();
  let votes: Map<number, GameVote> = new Map();
  try {
    [icons, info, votes] = await Promise.all([
      getGameIcons(universeIds),
      getGameInfo(universeIds),
      getGameVotes(universeIds),
    ]);
  } catch {
    // Render what we have.
  }
  // Re-resolve the live state in case the selection changed while fetching.
  const live = await getFolders();
  if (renderSeq !== foldersRenderSeq) return;
  const cur = live.folders.find((f) => f.id === folder.id);
  if (!cur || cur.id !== normalizeSelectedFolder(live)) return;

  // Sort by live player count per the user's preference. Games with no
  // playerCount fall to the bottom either direction so the sorted slice
  // never shows them above games we have data for.
  const ascending = settings.foldersGamesSort === 'least-active';
  const sortedGames = cur.games.slice().sort((a, b) => {
    const pa = info.get(a.universeId)?.playing;
    const pb = info.get(b.universeId)?.playing;
    const va = typeof pa === 'number' ? pa : -1;
    const vb = typeof pb === 'number' ? pb : -1;
    if (va === vb) return 0;
    if (va === -1) return 1;
    if (vb === -1) return -1;
    return ascending ? va - vb : vb - va;
  });

  row.innerHTML = sortedGames
    .map((g) => {
      const gi = info.get(g.universeId);
      const v = votes.get(g.universeId);
      return folderTileHtml(g.universeId, {
        name: gi?.name ?? g.name ?? `Universe ${g.universeId}`,
        href: gameHref(g.placeId ?? gi?.rootPlaceId, g.universeId),
        icon: icons.get(g.universeId),
        stats: {
          upVotes: v?.upVotes,
          downVotes: v?.downVotes,
          playerCount: gi?.playing,
        },
      });
    })
    .join('');

  // Wire the per-tile remove button.
  for (const btn of row.querySelectorAll<HTMLButtonElement>('[data-folder-remove]')) {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const uid = Number(btn.dataset.folderRemove);
      await removeGameFromFolder(folder.id, uid);
    });
  }
}

function folderRenderSignature(
  folders: Folder[],
  selectedId: string | null,
  gamesSort: Settings['foldersGamesSort']
): string {
  // Composition of state that changes the rendered tile row: folder list,
  // selection, current folder name, its game IDs in order, and the sort
  // setting (so flipping the sort triggers a re-render even though storage
  // didn't change).
  const cur = folders.find((f) => f.id === selectedId);
  const ids = cur ? cur.games.map((g) => g.universeId).join(',') : '';
  const folderList = folders.map((f) => `${f.id}:${f.name}:${f.games.length}`).join('|');
  return `${selectedId ?? ''}::${cur?.name ?? ''}::${ids}::${folderList}::${gamesSort}`;
}

function folderRowMatchesSelection(
  row: HTMLUListElement,
  folder: Folder | null,
  folderCount: number
): boolean {
  if (!folder) return folderCount === 0 && row.querySelector('.bp-fav-empty') != null;
  if (folder.games.length === 0) {
    return row.querySelector('.bp-fav-empty')?.textContent?.includes(folder.name) ?? false;
  }
  const renderedIds = [...row.querySelectorAll<HTMLElement>('[data-bp-universe-id]')]
    .map((el) => Number(el.dataset.bpUniverseId))
    .filter((id) => Number.isFinite(id));
  if (renderedIds.length !== folder.games.length) return false;
  const expected = new Set(folder.games.map((g) => g.universeId));
  return renderedIds.every((id) => expected.has(id));
}

interface FolderTileMeta {
  name: string;
  href: string;
  icon?: string;
  stats?: { upVotes?: number; downVotes?: number; playerCount?: number };
}

function folderTileHtml(universeId: number, meta: FolderTileMeta): string {
  const safeName = escapeHtml(meta.name);
  const safeHref = escapeHtml(meta.href);
  return `
    <li class="list-item game-card game-tile bp-fav-tile bp-folder-tile" data-bp-universe-id="${universeId}">
      <div class="game-card-container">
        <a class="game-card-link" href="${safeHref}" tabindex="0">
          <div class="game-card-thumb-container">
            <span class="thumbnail-2d-container game-tile-thumb">
              <img src="${escapeHtml(meta.icon ?? '')}" alt="${safeName}" title="${safeName}" loading="lazy" />
            </span>
            <button type="button" class="bp-folder-tile-remove"
                    data-folder-remove="${universeId}"
                    aria-label="Remove from folder"
                    title="Remove from folder">×</button>
          </div>
          <div class="game-card-name game-name-title" title="${safeName}">${safeName}</div>
          ${meta.stats ? gameStatsHtml(meta.stats) : ''}
        </a>
      </div>
    </li>
  `;
}

function ensureFoldersStyle(): void {
  if (document.getElementById(FOLDERS_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = FOLDERS_STYLE_ID;
  style.textContent = `
    #${FOLDERS_SECTION_ID} .bp-fav-header-actions {
      display: flex; align-items: center; gap: 6px;
    }
    .bp-folder-picker { position: relative; }
    .bp-folder-picker-trigger {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 6px;
      color: inherit; font: 600 12px/1 inherit;
      cursor: pointer; min-width: 140px; justify-content: space-between;
    }
    .bp-folder-picker-trigger:hover { background: rgba(255,255,255,0.10); }
    .bp-folder-picker-caret { opacity: 0.65; font-size: 10px; }
    .bp-folder-picker-menu {
      position: fixed; z-index: 9999;
      background: #1e2128; color: #e6e6e6;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px;
      box-shadow: 0 8px 28px rgba(0,0,0,0.45);
      padding: 6px;
      max-height: 320px; overflow-y: auto;
      font: 13px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    .bp-folder-picker-empty { padding: 8px 10px; opacity: 0.6; font-size: 12px; }
    .bp-folder-picker-item {
      display: flex; align-items: center; gap: 8px;
      width: 100%; padding: 6px 10px;
      background: transparent; border: 0; color: inherit;
      text-align: left; border-radius: 6px;
      cursor: pointer; font: inherit;
    }
    .bp-folder-picker-item:hover { background: rgba(255,255,255,0.08); }
    .bp-folder-picker-item-active { background: rgba(74,144,226,0.18); }
    .bp-folder-picker-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bp-folder-picker-count { font-size: 11px; opacity: 0.55; }
    .bp-folder-action {
      width: 28px; height: 28px;
      display: inline-flex; align-items: center; justify-content: center;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 6px;
      color: inherit; cursor: pointer;
      font: 14px/1 inherit;
    }
    .bp-folder-action:hover:not(:disabled) { background: rgba(255,255,255,0.10); }
    .bp-folder-action:disabled { opacity: 0.4; cursor: default; }
    .bp-folder-action-danger:hover:not(:disabled) {
      background: rgba(217, 83, 79, 0.2); border-color: #d9534f;
    }
    .bp-folder-tile { position: relative; }
    .bp-folder-tile-remove {
      position: absolute; top: 4px; right: 4px;
      width: 22px; height: 22px;
      display: none; align-items: center; justify-content: center;
      background: rgba(0,0,0,0.65); color: #fff;
      border: 1px solid rgba(255,255,255,0.25);
      border-radius: 50%;
      cursor: pointer; font: 700 14px/1 inherit;
      padding: 0;
      z-index: 3;
    }
    .bp-folder-tile:hover .bp-folder-tile-remove { display: inline-flex; }
    .bp-folder-tile-remove:hover { background: rgba(217, 83, 79, 0.85); }
  `;
  document.head.appendChild(style);
}
