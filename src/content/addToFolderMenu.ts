/**
 * Reusable popover anchored to a trigger element. Lists existing folders +
 * "New folder...". Picking a folder calls addGameToFolder; picking "New
 * folder..." prompts the user for a name and creates one. Used both by the
 * game-page "Add to folder" button and the per-tile (+) button on home tiles.
 */

import { addGameToFolder, createFolder, getFolders, FolderGame } from '@/storage/foldersStore';
import { escapeHtml } from '@/util/html';

const STYLE_ID = 'bloxplus-folder-menu-style';
const MENU_ID = 'bloxplus-folder-menu';

ensureStyle();

export interface OpenMenuOpts {
  anchor: HTMLElement;
  game: FolderGame;
  onAdded?: (folderName: string) => void;
}

let outsideHandlerAttached = false;
let escapeHandlerAttached = false;

export async function openFolderMenu(opts: OpenMenuOpts): Promise<void> {
  closeMenu();
  const state = await getFolders();
  const menu = document.createElement('div');
  menu.id = MENU_ID;
  menu.className = 'bp-folder-menu';
  menu.setAttribute('role', 'menu');

  const lines: string[] = [];
  if (!state.folders.length) {
    lines.push(`<div class="bp-folder-menu-empty">No folders yet</div>`);
  } else {
    for (const f of state.folders) {
      const has = f.games.some((g) => g.universeId === opts.game.universeId);
      lines.push(
        `<button type="button" class="bp-folder-menu-item${has ? ' bp-folder-menu-item-has' : ''}"
                 data-folder-id="${f.id}" ${has ? 'disabled' : ''}>
           <span class="bp-folder-menu-icon">${has ? '✓' : '+'}</span>
           <span class="bp-folder-menu-name">${escapeHtml(f.name)}</span>
           <span class="bp-folder-menu-count">${f.games.length}</span>
         </button>`
      );
    }
  }
  lines.push(`<div class="bp-folder-menu-sep"></div>`);
  lines.push(
    `<button type="button" class="bp-folder-menu-item bp-folder-menu-new" data-folder-new>
       <span class="bp-folder-menu-icon">＋</span>
       <span class="bp-folder-menu-name">New folder…</span>
     </button>`
  );
  menu.innerHTML = lines.join('');
  document.body.appendChild(menu);
  positionMenu(menu, opts.anchor);

  for (const el of menu.querySelectorAll<HTMLButtonElement>('[data-folder-id]')) {
    el.addEventListener('click', async () => {
      const id = el.dataset.folderId!;
      await addGameToFolder(id, opts.game);
      const folderName =
        state.folders.find((f) => f.id === id)?.name ?? 'folder';
      opts.onAdded?.(folderName);
      closeMenu();
    });
  }
  menu.querySelector('[data-folder-new]')?.addEventListener('click', async () => {
    const name = window.prompt('Folder name')?.trim();
    if (!name) {
      closeMenu();
      return;
    }
    const folder = await createFolder(name);
    await addGameToFolder(folder.id, opts.game);
    opts.onAdded?.(folder.name);
    closeMenu();
  });

  if (!outsideHandlerAttached) {
    document.addEventListener('mousedown', onOutsideMouseDown, true);
    outsideHandlerAttached = true;
  }
  if (!escapeHandlerAttached) {
    document.addEventListener('keydown', onEscape, true);
    escapeHandlerAttached = true;
  }
}

export function closeMenu(): void {
  document.getElementById(MENU_ID)?.remove();
}

function onOutsideMouseDown(e: MouseEvent): void {
  const menu = document.getElementById(MENU_ID);
  if (!menu) return;
  if (e.target instanceof Node && menu.contains(e.target)) return;
  closeMenu();
}

function onEscape(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeMenu();
}

function positionMenu(menu: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const menuW = 240;
  const left = Math.min(window.innerWidth - menuW - 8, Math.max(8, r.left));
  const top = r.bottom + 4;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .bp-folder-menu {
      position: fixed; z-index: 9999;
      min-width: 240px; max-width: 320px;
      background: #1e2128; color: #e6e6e6;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px;
      box-shadow: 0 8px 28px rgba(0,0,0,0.45);
      padding: 6px;
      font: 13px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    .bp-folder-menu-item {
      display: flex; align-items: center; gap: 8px;
      width: 100%; padding: 7px 10px;
      background: transparent; border: 0; color: inherit;
      text-align: left; border-radius: 6px;
      cursor: pointer; font: inherit;
    }
    .bp-folder-menu-item:hover:not([disabled]) { background: rgba(255,255,255,0.08); }
    .bp-folder-menu-item[disabled] { opacity: 0.55; cursor: default; }
    .bp-folder-menu-icon { width: 16px; text-align: center; opacity: 0.85; }
    .bp-folder-menu-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bp-folder-menu-count { font-size: 11px; opacity: 0.55; }
    .bp-folder-menu-sep {
      height: 1px; background: rgba(255,255,255,0.08); margin: 4px 0;
    }
    .bp-folder-menu-empty {
      padding: 8px 10px; opacity: 0.6; font-size: 12px;
    }
    .bp-folder-menu-new .bp-folder-menu-name { color: #4a90e2; }
  `;
  document.head.appendChild(style);
}
