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
  addFolderRow,
  removeFolderRow,
  setFolderRow,
  setMainRowSort,
  setFolderRowSort,
  FolderGamesSort,
  FoldersState,
  Folder,
} from '@/storage/foldersStore';
import { escapeHtml } from '@/util/html';
import {
  ensureFavoritesStyle,
  ensureHomeListScroller,
  gameHref,
  gameStatsHtml,
} from './favoritesSection';

export const FOLDERS_SECTION_ID = 'bloxplus-folders-section';
const FOLDERS_STYLE_ID = 'bloxplus-folders-style';
const EXTRA_ROWS_ID = 'bloxplus-folder-extra-rows';

// A folder row is either the original "main" row (driven by selectedFolderId)
// or an additional row added by the user (driven by extraRows[index]).
type RowSlot = { kind: 'main' } | { kind: 'extra'; index: number };

let foldersSubscribed = false;
let lastFoldersState: FoldersState | null = null;
let lastRenderedFolderSignature: string | null = null;
let foldersRenderSeq = 0;
// Module-level flag because the random pick must fire ONCE per page load,
// not every observer tick. Resets naturally when the page is reloaded.
let randomPickHandled = false;
// Bumped per row each time that row's filter (re-)enters "Random" so only
// that row reshuffles. It is part of signatures only while that row is random.
const randomSeeds = new Map<string, number>();
const SORT_CYCLE: FolderGamesSort[] = ['most-active', 'least-active', 'random'];

/** Returns a new array with the items shuffled (Fisher–Yates). */
function shuffle<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

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
          ${rowControlsHtml(false)}
          <button type="button" class="bp-folder-action bp-folder-add-row" data-folder-action="add-row"
                  title="Add another folder row">⊞ Add row</button>
        </div>
      </div>
      <ul class="bp-fav-row hlist games game-cards game-tile-list home-page-carousel"></ul>
      <div id="${EXTRA_ROWS_ID}" class="bp-folder-extra-rows"></div>
    `;

    // Main-row controls live in the section header (unchanged from the
    // original single-row layout).
    wireRowControls(section.querySelector<HTMLElement>('.bp-fav-header-actions')!, { kind: 'main' });

    // "Add row" appends a new extra row below; it appears once the store
    // change fires onFoldersChanged and we re-render.
    section
      .querySelector<HTMLButtonElement>('[data-folder-action="add-row"]')
      ?.addEventListener('click', async () => {
        const [state, settings] = await Promise.all([getFolders(), getSettings()]);
        // Default the new row to the first folder not already shown, else the
        // first folder, so it renders something useful immediately.
        const shown = new Set(
          [state.selectedFolderId, ...(state.extraRows ?? [])].filter(Boolean) as string[]
        );
        const pick = state.folders.find((f) => !shown.has(f.id)) ?? state.folders[0];
        const sort = slotSort(state, { kind: 'main' }, settings.foldersGamesSort as FolderGamesSort);
        await addFolderRow(pick?.id ?? null, sort);
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

/** The controls shared by row headers; only the main row gets folder management buttons. */
function rowControlsHtml(includeRemove: boolean, includeFolderActions = true): string {
  return `
    <div class="bp-folder-picker">
      <button type="button" class="bp-folder-picker-trigger" data-folder-picker>
        <span class="bp-folder-picker-label"></span>
        <span class="bp-folder-picker-caret">▾</span>
      </button>
    </div>
    ${
      includeFolderActions
        ? `<button type="button" class="bp-folder-action" data-folder-action="new"
                  title="New folder">＋</button>
           <button type="button" class="bp-folder-action" data-folder-action="rename"
                   title="Rename folder">✎</button>
           <button type="button" class="bp-folder-action bp-folder-action-danger"
                   data-folder-action="delete" title="Delete folder">🗑</button>`
        : ''
    }
    <button type="button" class="bp-folder-action bp-folder-sort" data-folder-action="sort"
            title="Filter games">▾ Most active</button>
    ${
      includeRemove
        ? `<span class="bp-folder-row-spacer"></span>
           <button type="button" class="bp-folder-action bp-folder-row-remove"
                   data-folder-action="remove-row" title="Remove this row">✕</button>`
        : ''
    }
  `;
}

/** Resolves the folder id currently shown in the given slot. */
async function slotFolderId(slot: RowSlot): Promise<string | null> {
  const state = await getFolders();
  if (slot.kind === 'main') return normalizeSelectedFolder(state);
  return state.extraRows?.[slot.index] || null;
}

/** Points the slot at a folder (main row updates selection; extra row its slot). */
async function setSlotFolder(slot: RowSlot, folderId: string): Promise<void> {
  if (slot.kind === 'main') await selectFolder(folderId);
  else await setFolderRow(slot.index, folderId);
}

function slotKey(slot: RowSlot): string {
  return slot.kind === 'main' ? 'main' : `extra:${slot.index}`;
}

function slotSort(
  state: FoldersState,
  slot: RowSlot,
  fallback: FolderGamesSort = 'most-active'
): FolderGamesSort {
  if (slot.kind === 'main') return state.mainRowSort ?? fallback;
  return state.extraRowSorts?.[slot.index] ?? state.mainRowSort ?? fallback;
}

function nextSort(sort: FolderGamesSort): FolderGamesSort {
  return SORT_CYCLE[(SORT_CYCLE.indexOf(sort) + 1) % SORT_CYCLE.length];
}

function bumpRandomSeed(slot: RowSlot): void {
  const key = slotKey(slot);
  randomSeeds.set(key, (randomSeeds.get(key) ?? 0) + 1);
}

function randomSeedFor(slot: RowSlot, sort: FolderGamesSort): number {
  return sort === 'random' ? randomSeeds.get(slotKey(slot)) ?? 0 : 0;
}

function sortButtonText(sort: FolderGamesSort): string {
  return sort === 'least-active'
    ? '▴ Least active'
    : sort === 'random'
      ? '🔀 Random'
      : '▾ Most active';
}

function sortButtonTitle(sort: FolderGamesSort): string {
  return sort === 'least-active'
    ? 'Sorted by fewest active players — click to shuffle'
    : sort === 'random'
      ? 'Shuffled order — click for most active'
      : 'Sorted by most active players — click for fewest';
}

function wireRowControls(host: HTMLElement, slot: RowSlot): void {
  const trigger = host.querySelector<HTMLButtonElement>('[data-folder-picker]');
  trigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    void openFolderPicker(trigger, slot);
  });

  host
    .querySelector<HTMLButtonElement>('[data-folder-action="new"]')
    ?.addEventListener('click', async () => {
      const name = window.prompt('New folder name')?.trim();
      if (!name) return;
      const folder = await createFolder(name);
      // createFolder marks it as the main selection; for an extra row point
      // that row at the freshly created folder instead.
      if (slot.kind === 'extra') await setFolderRow(slot.index, folder.id);
    });
  host
    .querySelector<HTMLButtonElement>('[data-folder-action="rename"]')
    ?.addEventListener('click', async () => {
      const id = await slotFolderId(slot);
      const state = await getFolders();
      const cur = state.folders.find((f) => f.id === id);
      if (!cur) return;
      const next = window.prompt('Rename folder', cur.name)?.trim();
      if (!next || next === cur.name) return;
      await renameFolder(cur.id, next);
    });
  host
    .querySelector<HTMLButtonElement>('[data-folder-action="delete"]')
    ?.addEventListener('click', async () => {
      const id = await slotFolderId(slot);
      const state = await getFolders();
      const cur = state.folders.find((f) => f.id === id);
      if (!cur) return;
      const ok = window.confirm(`Delete folder "${cur.name}"? Games inside are not deleted from Roblox.`);
      if (!ok) return;
      await deleteFolder(cur.id);
    });
  host
    .querySelector<HTMLButtonElement>('[data-folder-action="sort"]')
    ?.addEventListener('click', async () => {
      const [state, settings] = await Promise.all([getFolders(), getSettings()]);
      const current = slotSort(state, slot, settings.foldersGamesSort as FolderGamesSort);
      const next = nextSort(current);
      if (next === 'random') bumpRandomSeed(slot);
      if (slot.kind === 'main') await setMainRowSort(next);
      else await setFolderRowSort(slot.index, next);
    });
  if (slot.kind === 'extra') {
    host
      .querySelector<HTMLButtonElement>('[data-folder-action="remove-row"]')
      ?.addEventListener('click', async () => {
        await removeFolderRow(slot.index);
      });
  }
}

async function openFolderPicker(trigger: HTMLElement, slot: RowSlot): Promise<void> {
  const existing = document.getElementById('bloxplus-folder-picker-menu');
  if (existing) { existing.remove(); return; }
  const state = await getFolders();
  const activeId = slot.kind === 'main' ? state.selectedFolderId : state.extraRows?.[slot.index] ?? null;

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
            f.id === activeId ? ' bp-folder-picker-item-active' : ''
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
      await setSlotFolder(slot, el.dataset.folderId!);
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
  // the user picked the "Random folder each refresh" option. Applies to the
  // MAIN row only; subsequent observer ticks short-circuit via randomPickHandled.
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
    randomPickHandled = true;
  }

  // If the main selection is invalid, snap to the first folder and repair
  // storage. A dead selectedFolderId makes async render guards treat the
  // visible folder as stale and can leave the row blank.
  const selectedId = normalizeSelectedFolder(state);
  if (selectedId !== state.selectedFolderId) {
    state = { ...state, selectedFolderId: selectedId };
    lastFoldersState = state;
    void selectFolder(selectedId);
  }

  const mainRow = section.querySelector<HTMLUListElement>(':scope > .bp-fav-scroll > .bp-fav-row, :scope > .bp-fav-row');
  const extrasHost = section.querySelector<HTMLElement>(`#${EXTRA_ROWS_ID}`);
  if (!mainRow || !extrasHost) return;

  const extraRows = state.extraRows ?? [];

  // Fast no-op path: ensureFoldersSection runs on every home-reorder mutation
  // tick, so bail immediately when nothing across any row changed. After
  // returning from another overlay (Themes/UHBL) Roblox can hand back the same
  // section with stale rows, so verify the DOM still matches too.
  const fallbackSort = settings.foldersGamesSort as FolderGamesSort;
  const mainSlot: RowSlot = { kind: 'main' };
  const mainSort = slotSort(state, mainSlot, fallbackSort);
  const signature = foldersSignature(state, selectedId, fallbackSort);
  const globalUnchanged =
    signature === lastRenderedFolderSignature && foldersDomMatches(section, state, selectedId);
  lastRenderedFolderSignature = signature;
  if (globalUnchanged) return;
  const renderSeq = ++foldersRenderSeq;

  const mainFolder = state.folders.find((f) => f.id === selectedId) ?? null;

  // Main header (picker label, rename/delete enabled, sort toggle) — cheap and
  // never reflows tiles, so always refresh it.
  const mainHeader = section.querySelector<HTMLElement>('.bp-fav-header-actions');
  if (mainHeader) {
    updateRowHeader(mainHeader, mainFolder, state.folders.length, mainSort);
  }

  // Reconcile only the COUNT of extra-row blocks (add/remove at the end). Rows
  // that stay keep their DOM, listeners, and already-loaded thumbnails — this
  // is what stops editing one folder from flickering every row.
  reconcileExtraBlocks(extrasHost, extraRows.length);

  // Decide which rows actually changed; only those get their tile strip
  // re-rendered. Each row carries its own content+sort signature in dataset.
  const changed: Array<{
    row: HTMLUListElement;
    folder: Folder | null;
    sig: string;
    isExtra: boolean;
    sort: FolderGamesSort;
  }> = [];

  const mainCheck = rowNeedsRender(
    mainRow,
    mainFolder,
    mainSort,
    randomSeedFor(mainSlot, mainSort)
  );
  if (mainCheck.changed) {
    changed.push({ row: mainRow, folder: mainFolder, sig: mainCheck.sig, isExtra: false, sort: mainSort });
  }
  for (const block of extrasHost.querySelectorAll<HTMLElement>(':scope > .bp-folder-row')) {
    const index = Number(block.dataset.rowIndex);
    const slot: RowSlot = { kind: 'extra', index };
    const rowSortValue = slotSort(state, slot, fallbackSort);
    const folder = state.folders.find((f) => f.id === extraRows[index]) ?? null;
    const header = block.querySelector<HTMLElement>('.bp-folder-row-header');
    if (header) updateRowHeader(header, folder, state.folders.length, rowSortValue);
    const row = block.querySelector<HTMLUListElement>('.bp-fav-row');
    if (!row) continue;
    const check = rowNeedsRender(
      row,
      folder,
      rowSortValue,
      randomSeedFor(slot, rowSortValue)
    );
    if (check.changed) {
      changed.push({ row, folder, sig: check.sig, isExtra: true, sort: rowSortValue });
    }
  }

  if (!changed.length) return;

  // Skeleton only the changed rows from cached folder data.
  for (const c of changed) fillRowSkeleton(c.row, c.folder, c.isExtra);

  // Fetch only the universes the changed rows need (cached, so cheap).
  const universeIds = [
    ...new Set(changed.flatMap((c) => (c.folder ? c.folder.games.map((g) => g.universeId) : []))),
  ];
  if (universeIds.length) {
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
      // Keep skeleton tiles.
    }
    // A newer render superseded us — let it own the final paint + signatures.
    if (renderSeq !== foldersRenderSeq) return;
    for (const c of changed) enrichRow(c.row, c.folder?.id, state, icons, info, votes, c.sort);
  }

  // Commit per-row signatures only after this render produced the final paint,
  // so a superseded render never marks a row "done" at the skeleton stage.
  for (const c of changed) c.row.dataset.bpRowSig = c.sig;
}

function rowSignature(folder: Folder | null, sort: FolderGamesSort, randomSeed: number): string {
  const seed = sort === 'random' ? `:r${randomSeed}` : '';
  if (!folder) return `none::${sort}${seed}`;
  return `${folder.id}:${folder.name}:${folder.games.map((g) => g.universeId).join('.')}::${sort}${seed}`;
}

/** Whether a row's tile strip needs re-rendering, plus the target signature. */
function rowNeedsRender(
  row: HTMLUListElement,
  folder: Folder | null,
  sort: FolderGamesSort,
  randomSeed: number
): { changed: boolean; sig: string } {
  const sig = rowSignature(folder, sort, randomSeed);
  const unchanged = row.dataset.bpRowSig === sig && rowMatchesFolder(row, folder);
  return { changed: !unchanged, sig };
}

/** Adds/removes extra-row blocks at the end to match `desired`, leaving kept
 *  blocks (and their loaded tiles) untouched. New blocks are wired once here. */
function reconcileExtraBlocks(extrasHost: HTMLElement, desired: number): void {
  const blocks = [...extrasHost.querySelectorAll<HTMLElement>(':scope > .bp-folder-row')];
  for (let i = blocks.length - 1; i >= desired; i--) blocks[i].remove();
  for (let i = blocks.length; i < desired; i++) {
    extrasHost.insertAdjacentHTML('beforeend', extraRowHtml(i));
    const block = extrasHost.lastElementChild as HTMLElement;
    ensureHomeListScroller(block);
    const header = block.querySelector<HTMLElement>('.bp-folder-row-header');
    if (header) wireRowControls(header, { kind: 'extra', index: i });
  }
}

function extraRowHtml(index: number): string {
  return `
    <div class="bp-folder-row" data-row-index="${index}">
      <div class="bp-folder-row-header">${rowControlsHtml(true, false)}</div>
      <ul class="bp-fav-row hlist games game-cards game-tile-list home-page-carousel"></ul>
    </div>
  `;
}

function updateRowHeader(
  header: HTMLElement,
  folder: Folder | null,
  folderCount: number,
  sort: FolderGamesSort
): void {
  const label = header.querySelector<HTMLElement>('.bp-folder-picker-label');
  if (label) {
    label.textContent = folder ? folder.name : folderCount ? 'Pick a folder' : 'No folders yet';
  }
  for (const action of ['rename', 'delete'] as const) {
    const btn = header.querySelector<HTMLButtonElement>(`[data-folder-action="${action}"]`);
    if (btn) btn.disabled = !folder;
  }
  const sortBtn = header.querySelector<HTMLButtonElement>('[data-folder-action="sort"]');
  if (sortBtn) {
    sortBtn.textContent = sortButtonText(sort);
    sortBtn.title = sortButtonTitle(sort);
  }
}

function fillRowSkeleton(row: HTMLUListElement, folder: Folder | null, isExtra = false): void {
  if (!folder) {
    row.innerHTML = isExtra
      ? `<li class="bp-fav-empty">Pick a folder for this row.</li>`
      : `<li class="bp-fav-empty">Create a folder, then add games from any game page.</li>`;
    return;
  }
  if (!folder.games.length) {
    row.innerHTML = `<li class="bp-fav-empty">No games in "${escapeHtml(folder.name)}" yet. Open a game and use the Folder button.</li>`;
    return;
  }
  row.innerHTML = folder.games
    .map((g) =>
      folderTileHtml(g.universeId, {
        name: g.name ?? `Universe ${g.universeId}`,
        href: gameHref(g.placeId, g.universeId),
      })
    )
    .join('');
}

function enrichRow(
  row: HTMLUListElement,
  folderId: string | null | undefined,
  state: FoldersState,
  icons: Map<number, string>,
  info: Map<number, GameInfo>,
  votes: Map<number, GameVote>,
  sort: FolderGamesSort
): void {
  const folder = folderId ? state.folders.find((f) => f.id === folderId) ?? null : null;
  if (!folder || !folder.games.length) return;

  const sortedGames =
    sort === 'random'
      ? shuffle(folder.games)
      : folder.games.slice().sort((a, b) => {
          const pa = info.get(a.universeId)?.playing;
          const pb = info.get(b.universeId)?.playing;
          const va = typeof pa === 'number' ? pa : -1;
          const vb = typeof pb === 'number' ? pb : -1;
          if (va === vb) return 0;
          if (va === -1) return 1;
          if (vb === -1) return -1;
          return sort === 'least-active' ? va - vb : vb - va;
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

  for (const btn of row.querySelectorAll<HTMLButtonElement>('[data-folder-remove]')) {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const uid = Number(btn.dataset.folderRemove);
      await removeGameFromFolder(folder.id, uid);
    });
  }
}

function foldersSignature(
  state: FoldersState,
  selectedId: string | null,
  fallbackSort: FolderGamesSort
): string {
  const rowIds = [selectedId ?? '', ...(state.extraRows ?? [])];
  const rows = rowIds.map((id, index) => {
    const slot: RowSlot = index === 0 ? { kind: 'main' } : { kind: 'extra', index: index - 1 };
    const sort = slotSort(state, slot, fallbackSort);
    const seed = randomSeedFor(slot, sort);
    const f = state.folders.find((x) => x.id === id);
    const folderPart = f
      ? `${f.id}:${f.name}:${f.games.map((g) => g.universeId).join('.')}`
      : `none:${id}`;
    return `${folderPart}:${sort}:${seed}`;
  });
  const folderList = state.folders.map((f) => `${f.id}:${f.name}:${f.games.length}`).join('|');
  return `${rows.join('||')}::${folderList}`;
}

function foldersDomMatches(section: HTMLElement, state: FoldersState, selectedId: string | null): boolean {
  const extrasHost = section.querySelector<HTMLElement>(`#${EXTRA_ROWS_ID}`);
  if (!extrasHost) return false;
  const blocks = [...extrasHost.querySelectorAll<HTMLElement>(':scope > .bp-folder-row')];
  if (blocks.length !== (state.extraRows?.length ?? 0)) return false;
  const mainRow = section.querySelector<HTMLUListElement>(':scope > .bp-fav-scroll > .bp-fav-row, :scope > .bp-fav-row');
  if (!mainRow) return false;
  const mainFolder = state.folders.find((f) => f.id === selectedId) ?? null;
  if (!rowMatchesFolder(mainRow, mainFolder)) return false;
  return blocks.every((block, index) => {
    const row = block.querySelector<HTMLUListElement>('.bp-fav-row');
    if (!row) return false;
    const folder = state.folders.find((f) => f.id === state.extraRows?.[index]) ?? null;
    return rowMatchesFolder(row, folder);
  });
}

function rowMatchesFolder(row: HTMLUListElement, folder: Folder | null): boolean {
  if (!folder) {
    return row.querySelector('.bp-fav-empty') != null;
  }
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
    #${FOLDERS_SECTION_ID} .bp-fav-header {
      flex-direction: column; align-items: flex-start; gap: 8px;
    }
    #${FOLDERS_SECTION_ID} .bp-fav-header-actions {
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
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
    .bp-folder-sort,
    .bp-folder-add-row {
      width: auto !important;
      padding: 0 10px !important;
      gap: 4px; white-space: nowrap;
      font: 600 12px/1 inherit;
    }
    .bp-folder-extra-rows {
      display: flex; flex-direction: column; gap: 14px;
      margin-top: 14px;
    }
    .bp-folder-row { min-width: 0; }
    .bp-folder-row-header {
      display: flex; align-items: center; gap: 6px;
      margin: 0 0 6px 2px;
    }
    .bp-folder-row-spacer { flex: 1; }
    .bp-folder-row-remove:hover:not(:disabled) {
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
