/**
 * Injects an "Add to folder ▾" button into the favorite/follow/vote/share row
 * on game pages (/games/<placeId>). Clicking opens the shared folder menu.
 */

import { openFolderMenu } from './addToFolderMenu';
import { placeIdToUniverseId, getGameInfo } from '@/api/games';
import { getFolders, onFoldersChanged, FoldersState } from '@/storage/foldersStore';

const BUTTON_ID = 'bloxplus-add-to-folder-btn';
const STYLE_ID = 'bloxplus-add-to-folder-btn-style';

interface PageContext {
  placeId: number;
  universeId: number;
  name?: string;
}

let cached: PageContext | null = null;
let cachedForPlaceId: number | null = null;

export async function run(): Promise<void> {
  const placeId = readPlaceId();
  if (!placeId) {
    document.getElementById(BUTTON_ID)?.remove();
    return;
  }

  const ul = document.querySelector<HTMLUListElement>('.favorite-follow-vote-share');
  if (!ul) return;
  const existing = document.getElementById(BUTTON_ID) as HTMLLIElement | null;
  if (existing) {
    if (existing.dataset.bpPlaceId === String(placeId)) return;
    existing.remove();
  }

  ensureStyle();

  const li = document.createElement('li');
  li.id = BUTTON_ID;
  li.className = 'bp-folder-btn-li';
  li.dataset.bpPlaceId = String(placeId);
  li.innerHTML = `
    <button type="button" class="bp-folder-btn" aria-label="Add to folder">
      <span class="bp-folder-btn-icon" aria-hidden="true">
        <svg class="bp-folder-icon-plus" viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="10" cy="10" r="8" />
          <path d="M10 6 V14 M6 10 H14" stroke-linecap="round" />
        </svg>
        <svg class="bp-folder-icon-check" viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="10" cy="10" r="8" />
          <path d="M6 10 l3 3 l5 -6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
      <span class="bp-folder-btn-label">Folder</span>
    </button>
  `;
  ul.appendChild(li);

  const btn = li.querySelector<HTMLButtonElement>('.bp-folder-btn')!;
  btn.addEventListener('click', async () => {
    const livePlaceId = Number(li.dataset.bpPlaceId);
    if (!Number.isFinite(livePlaceId)) return;
    const ctx = await resolveContext(livePlaceId);
    if (!li.isConnected || readPlaceId() !== livePlaceId) return;
    if (!ctx) return;
    void openFolderMenu({
      anchor: btn,
      game: { universeId: ctx.universeId, placeId: ctx.placeId, name: ctx.name },
      onAdded: () => flashLabel(btn, 'Added'),
    });
  });

  // Reflect whether the game is already in a folder. Initial paint + live
  // updates on storage change.
  void resolveContext(placeId).then((ctx) => {
    if (!li.isConnected || readPlaceId() !== placeId) return;
    if (!ctx) return;
    li.dataset.bpUniverseId = String(ctx.universeId);
    void getFolders().then((state) => syncButtonState(btn, ctx.universeId, state));
    if (!buttonStateSubscribed) {
      buttonStateSubscribed = true;
      onFoldersChanged((state) => {
        const live = document.querySelector<HTMLButtonElement>(
          `#${BUTTON_ID} .bp-folder-btn`
        );
        const liveLi = document.getElementById(BUTTON_ID) as HTMLLIElement | null;
        const universeId = liveLi ? Number(liveLi.dataset.bpUniverseId) : NaN;
        if (live && Number.isFinite(universeId)) syncButtonState(live, universeId, state);
      });
    }
  });
}

let buttonStateSubscribed = false;

function syncButtonState(
  btn: HTMLButtonElement,
  universeId: number,
  state: FoldersState
): void {
  const inFolder = state.folders.some((f) =>
    f.games.some((g) => g.universeId === universeId)
  );
  btn.classList.toggle('bp-in-folder', inFolder);
  const label = btn.querySelector<HTMLSpanElement>('.bp-folder-btn-label');
  if (label) label.textContent = inFolder ? 'In folder' : 'Folder';
}

async function resolveContext(placeId: number): Promise<PageContext | null> {
  if (cached && cachedForPlaceId === placeId) return cached;
  const universeId = await placeIdToUniverseId(placeId);
  if (!universeId) return null;
  let name: string | undefined;
  try {
    const info = await getGameInfo([universeId]);
    name = info.get(universeId)?.name;
  } catch {
    // optional
  }
  cached = { placeId, universeId, name };
  cachedForPlaceId = placeId;
  return cached;
}

function flashLabel(btn: HTMLButtonElement, text: string): void {
  const label = btn.querySelector<HTMLSpanElement>('.bp-folder-btn-label');
  if (!label) return;
  const original = label.textContent;
  label.textContent = text;
  window.setTimeout(() => {
    if (label.textContent === text) label.textContent = original;
  }, 1200);
}

function readPlaceId(): number | null {
  const m = location.pathname.match(/\/games\/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .bp-folder-btn-li {
      display: flex; align-items: center; justify-content: center;
      list-style: none;
    }
    .bp-folder-btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 999px;
      background: rgba(255,255,255,0.04);
      color: inherit;
      font: 600 12px/1 inherit;
      cursor: pointer;
    }
    .bp-folder-btn:hover { background: rgba(255,255,255,0.10); }
    .bp-folder-btn-icon {
      display: inline-flex; align-items: center; justify-content: center;
      line-height: 0;
    }
    .bp-folder-btn .bp-folder-icon-check { display: none; }
    .bp-folder-btn.bp-in-folder .bp-folder-icon-plus { display: none; }
    .bp-folder-btn.bp-in-folder .bp-folder-icon-check { display: inline-block; }
    .bp-folder-btn.bp-in-folder {
      background: rgba(46,178,76,0.18);
      border-color: rgba(46,178,76,0.6);
      color: #b5f0c8;
    }
  `;
  document.head.appendChild(style);
}
