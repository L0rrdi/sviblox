/**
 * Single-key hotkey system. Reads bindings from `settings.gameHotkeys`
 * (`{ destinationId: keyChar }`) and routes keystrokes to:
 *   - smooth-scroll an in-page element (game-page destinations), or
 *   - navigate to a URL (site-level destinations).
 *
 * Listener is installed once on first dispatch. Settings changes update the
 * in-memory key→destination map live via `chrome.storage.onChanged`.
 *
 * Holding `?` (no input focus, no modifiers) shows a help overlay listing
 * the active bindings. It hides on the next `keyup`, so it's a hold rather
 * than a toggle.
 */

import { getSettings, onSettingsChanged } from '@/storage/settingsStore';
import { getFolders, onFoldersChanged, FoldersState, FolderGame } from '@/storage/foldersStore';
import { getAuthenticatedUserId } from '@/api/users';
import { getGameInfo } from '@/api/games';
import { escapeHtml } from '@/util/html';
import {
  HOTKEY_DESTINATIONS,
  HOTKEY_DESTINATION_BY_ID,
  HotkeyDestination,
  RESERVED_HOTKEY_KEYS,
  isKnownHotkeyDestinationId,
  parseFolderGameHotkeyId,
} from './hotkeyDestinations';

const HELP_OVERLAY_KEY = '|';

const OVERLAY_ID = 'bloxplus-hotkey-overlay';
const OVERLAY_STYLE_ID = 'bloxplus-hotkey-overlay-style';

let listenersInstalled = false;
/** key → destinationId, derived from the canonical destinationId → key map. */
let keyToDestination = new Map<string, string>();
let overlayVisible = false;
let foldersState: FoldersState = { folders: [], selectedFolderId: null };

export async function run(): Promise<void> {
  if (!listenersInstalled) {
    listenersInstalled = true;
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    onSettingsChanged((s) => {
      keyToDestination = invert(s.gameHotkeys ?? {});
      if (overlayVisible) renderOverlay();
    });
    onFoldersChanged((state) => {
      foldersState = state;
      if (overlayVisible) renderOverlay();
    });
  }
  const [settings, folders] = await Promise.all([getSettings(), getFolders()]);
  keyToDestination = invert(settings.gameHotkeys ?? {});
  foldersState = folders;
}

function invert(map: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [destId, key] of Object.entries(map)) {
    if (typeof key !== 'string' || key.length !== 1) continue;
    if (RESERVED_HOTKEY_KEYS.has(key)) continue;
    if (!isKnownHotkeyDestinationId(destId)) continue;
    out.set(key, destId);
  }
  return out;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function onKeyDown(e: KeyboardEvent): void {
  if (isTypingTarget(e.target)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  // Help overlay — open on the first `|` press, ignore key-repeats.
  if (e.key === HELP_OVERLAY_KEY && !e.repeat) {
    e.preventDefault();
    showOverlay();
    return;
  }

  // Don't trigger jumps while the overlay is up — releasing the key dismisses
  // it, and the user is in "looking at my bindings" mode, not jump mode.
  if (overlayVisible) return;

  const key = e.key.toLowerCase();
  if (RESERVED_HOTKEY_KEYS.has(key)) return;
  if (key.length !== 1) return;
  const destId = keyToDestination.get(key);
  if (!destId) return;
  const dest = HOTKEY_DESTINATION_BY_ID.get(destId);
  if (!dest && parseFolderGameHotkeyId(destId) === null) return;
  // Only swallow the keystroke once we've confirmed we're going to act.
  e.preventDefault();
  // Roblox shows white :focus-visible outlines on whatever element last had
  // focus (search box, nav link) the moment we register a keydown. Drop
  // focus before we scroll/navigate so no ring flashes around the navbar.
  blurActive();
  void executeJump(destId, dest);
}

function onKeyUp(e: KeyboardEvent): void {
  if (!overlayVisible) return;
  // Hold-not-toggle semantics, but only dismiss when an overlay-relevant
  // key is released. Without this, tapping any letter while the overlay
  // is up would dismiss it on that letter's keyup. The overlay key (`|`)
  // requires Shift+\\ on US layouts, so either Shift, \\, or | releasing
  // counts as "no longer holding |".
  if (e.key !== HELP_OVERLAY_KEY && e.key !== 'Shift' && e.key !== '\\') return;
  hideOverlay();
  // Same focus-ring cleanup as after a jump — keyup flips :focus-visible
  // back on for whatever the browser thinks is focused.
  blurActive();
}

function blurActive(): void {
  const el = document.activeElement;
  if (el instanceof HTMLElement && el !== document.body) {
    el.blur();
  }
}

async function executeJump(destId: string, dest: HotkeyDestination | undefined): Promise<void> {
  const folderGameUniverseId = parseFolderGameHotkeyId(destId);
  if (folderGameUniverseId !== null) {
    const path = await resolveFolderGamePath(folderGameUniverseId);
    if (!path) return;
    if (location.pathname === path) return;
    location.assign(path);
    return;
  }
  if (!dest) return;
  if (dest.scope === 'site') {
    const path = await resolveSitePath(dest);
    if (!path) return;
    if (location.pathname === path) return; // already there
    location.assign(path);
    return;
  }
  // Game-page scroll target — only meaningful on /games/{placeId}.
  if (!/^\/games\/\d+/.test(location.pathname)) return;
  const el = findFirst(dest.selectors);
  if (!el) return;
  const block = dest.id === 'game-play' ? 'center' : 'start';
  el.scrollIntoView({ behavior: 'smooth', block });
  flashHighlight(el);
}

async function resolveFolderGamePath(universeId: number): Promise<string | null> {
  const local = findFolderGame(universeId);
  if (!local) return null;
  if (local?.placeId) return `/games/${local.placeId}`;
  const info = await getGameInfo([universeId]);
  const rootPlaceId = info.get(universeId)?.rootPlaceId;
  return rootPlaceId ? `/games/${rootPlaceId}` : null;
}

function findFolderGame(universeId: number): FolderGame | null {
  for (const folder of foldersState.folders) {
    const game = folder.games.find((g) => g.universeId === universeId);
    if (game) return game;
  }
  return null;
}

async function resolveSitePath(
  dest: HotkeyDestination & { scope: 'site' }
): Promise<string | null> {
  // The "My Profile" entry needs the authenticated userId — Roblox has no
  // /my/profile redirect, so we build /users/{id}/profile at jump time.
  if (dest.id === 'site-profile') {
    const me = await getAuthenticatedUserId();
    return me ? `/users/${me}/profile` : null;
  }
  return dest.path || null;
}

function findFirst(selectors: readonly string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

// Per-element timer so a second jump within 900 ms doesn't strand the first
// element with a stuck purple ring (single shared timer used to overwrite
// the prior one but only remove the class from the *latest* target).
const flashTimers = new WeakMap<HTMLElement, number>();
function flashHighlight(el: HTMLElement): void {
  const prior = flashTimers.get(el);
  if (prior !== undefined) window.clearTimeout(prior);
  el.classList.add('bp-hotkey-flash');
  const t = window.setTimeout(() => {
    el.classList.remove('bp-hotkey-flash');
    flashTimers.delete(el);
  }, 900);
  flashTimers.set(el, t);
}

function showOverlay(): void {
  if (overlayVisible) return;
  overlayVisible = true;
  ensureOverlayStyle();
  renderOverlay();
}

function hideOverlay(): void {
  overlayVisible = false;
  document.getElementById(OVERLAY_ID)?.remove();
}

function renderOverlay(): void {
  let overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'SviBlox hotkeys');
    document.body.appendChild(overlay);
  }

  const rows = gatherRows();
  const rowsHtml = rows.length
    ? rows
        .map(
          (r) => `
            <div class="bp-hotkey-row${r.disabled ? ' bp-hotkey-row-disabled' : ''}">
              <kbd class="bp-hotkey-key">${escapeHtml(r.key)}</kbd>
              <span class="bp-hotkey-label">${escapeHtml(r.label)}</span>
            </div>
          `
        )
        .join('')
    : '<div class="bp-hotkey-empty">No bindings yet.</div>';

  overlay.innerHTML = `
    <div class="bp-hotkey-card">
      <header class="bp-hotkey-header">
        <strong>Keybinds</strong>
        <span class="bp-hotkey-hint">release to dismiss</span>
      </header>
      <div class="bp-hotkey-body">${rowsHtml}</div>
    </div>
  `;
}

interface OverlayRow {
  key: string;
  label: string;
  disabled: boolean;
}

function gatherRows(): OverlayRow[] {
  const rows: OverlayRow[] = [];
  const onGamePage = /^\/games\/\d+/.test(location.pathname);
  for (const [key, destId] of keyToDestination) {
    const dest = HOTKEY_DESTINATION_BY_ID.get(destId);
    if (dest) {
      rows.push({
        key,
        label: dest.label,
        disabled: dest.scope === 'game' && !onGamePage,
      });
      continue;
    }
    const universeId = parseFolderGameHotkeyId(destId);
    if (universeId === null) continue;
    const game = findFolderGame(universeId);
    rows.push({
      key,
      label: `Game: ${game?.name || `Universe ${universeId}`}`,
      disabled: !game,
    });
  }
  rows.sort((a, b) => a.key.localeCompare(b.key));
  return rows;
}

function ensureOverlayStyle(): void {
  if (document.getElementById(OVERLAY_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = OVERLAY_STYLE_ID;
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0,0,0,0.55);
      z-index: 2147483600;
      animation: bp-hotkey-fade 0.12s ease-out;
    }
    @keyframes bp-hotkey-fade {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    #${OVERLAY_ID} .bp-hotkey-card {
      min-width: 360px;
      max-width: 560px;
      max-height: 80vh;
      overflow-y: auto;
      padding: 18px 22px;
      border-radius: 12px;
      background: #181c24;
      color: #e6e8ed;
      border: 1px solid rgba(255,255,255,0.10);
      box-shadow: 0 22px 60px rgba(0,0,0,0.45);
      font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
    }
    #${OVERLAY_ID} .bp-hotkey-header {
      display: flex; align-items: baseline; justify-content: space-between;
      gap: 12px; margin-bottom: 10px;
    }
    #${OVERLAY_ID} .bp-hotkey-header strong {
      font-size: 16px; font-weight: 700;
    }
    #${OVERLAY_ID} .bp-hotkey-hint {
      font-size: 11px; color: rgba(255,255,255,0.55);
    }
    #${OVERLAY_ID} .bp-hotkey-row {
      display: flex; align-items: center; gap: 12px;
      padding: 6px 0;
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    #${OVERLAY_ID} .bp-hotkey-row:first-of-type {
      border-top: 0;
    }
    #${OVERLAY_ID} .bp-hotkey-row-disabled {
      opacity: 0.45;
    }
    #${OVERLAY_ID} .bp-hotkey-key {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 28px; height: 24px;
      padding: 0 7px;
      border-radius: 5px;
      background: rgba(255,255,255,0.10);
      border: 1px solid rgba(255,255,255,0.18);
      font: 700 12px/1 ui-monospace, SFMono-Regular, Consolas, monospace;
      color: #c5b3ff;
      text-transform: uppercase;
    }
    #${OVERLAY_ID} .bp-hotkey-label {
      flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #${OVERLAY_ID} .bp-hotkey-empty {
      padding: 4px 0;
      color: rgba(255,255,255,0.45);
      font-size: 12px;
    }
    .bp-hotkey-flash {
      animation: bp-hotkey-flash-keyframes 0.9s ease-out;
    }
    @keyframes bp-hotkey-flash-keyframes {
      0%   { box-shadow: 0 0 0 0 rgba(116, 64, 234, 0.0), 0 0 0 0 rgba(116, 64, 234, 0.0); }
      30%  { box-shadow: 0 0 0 4px rgba(116, 64, 234, 0.55), 0 0 18px 4px rgba(116, 64, 234, 0.35); }
      100% { box-shadow: 0 0 0 0 rgba(116, 64, 234, 0.0), 0 0 0 0 rgba(116, 64, 234, 0.0); }
    }
  `;
  document.head.appendChild(style);
}

// Re-export the destination list for the popup so popup doesn't need a
// duplicate import path.
export { HOTKEY_DESTINATIONS };
