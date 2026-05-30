/**
 * Injects a "lifetime playtime" pill into the favorite/follow/vote/share row
 * on game pages (/games/<placeId>). Sits immediately left of the SviBlox
 * "Folder" button. Dispatch order alone isn't enough — both enhancers do
 * async work and the folder button often wins the append race. We explicitly
 * `insertBefore` the folder button if it's already mounted; otherwise we
 * `appendChild` and the folder button lands on our right when it runs next.
 *
 * Display-only — shows the lifetime total (importedSeconds + trackedSeconds)
 * for this game's universeId. The full breakdown is surfaced via the button's
 * tooltip. Tracking is unchanged; this is purely a readout.
 *
 * Gated by `settings.playtimeTracker` — turned off, the button is removed
 * (the tracker switch is the canonical "do I care about playtime" toggle).
 */

import { getSettings } from '@/storage/settingsStore';
import { getPlaytime } from '@/storage/playtimeStore';
import { placeIdToUniverseId } from '@/api/games';
import { GamePlaytimeEntry } from '@/types';

const BUTTON_ID = 'bloxplus-game-playtime-btn';
const STYLE_ID = 'bloxplus-game-playtime-btn-style';

let cachedUniverseId: number | null = null;
let cachedForPlaceId: number | null = null;
let subscribed = false;

export async function run(): Promise<void> {
  const placeId = readPlaceId();
  if (!placeId) {
    document.getElementById(BUTTON_ID)?.remove();
    return;
  }

  const settings = await getSettings();
  if (!settings.playtimeTracker) {
    document.getElementById(BUTTON_ID)?.remove();
    return;
  }

  const ul = document.querySelector<HTMLUListElement>('.favorite-follow-vote-share');
  if (!ul) return;
  const existing = document.getElementById(BUTTON_ID) as HTMLLIElement | null;
  if (existing) {
    // Defensive reorder: if the folder button raced in front of us on the
    // first dispatch tick, slide us back left of it on the next tick.
    const folderLi = document.getElementById('bloxplus-add-to-folder-btn');
    if (
      folderLi &&
      folderLi.parentElement === ul &&
      existing.compareDocumentPosition(folderLi) & Node.DOCUMENT_POSITION_PRECEDING
    ) {
      ul.insertBefore(existing, folderLi);
    }
    if (existing.dataset.bpPlaceId !== String(placeId)) {
      existing.dataset.bpPlaceId = String(placeId);
      const btn = existing.querySelector<HTMLButtonElement>('.bp-playtime-btn');
      if (btn) void hydrate(btn, placeId);
    }
    return;
  }

  ensureStyle();

  const li = document.createElement('li');
  li.id = BUTTON_ID;
  li.className = 'bp-playtime-btn-li';
  li.dataset.bpPlaceId = String(placeId);
  li.innerHTML = `
    <button type="button" class="bp-playtime-btn" aria-label="Lifetime playtime">
      <span class="bp-playtime-btn-icon" aria-hidden="true">
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="10" cy="10" r="8" />
          <path d="M10 5 V10 L13.5 12" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
      <span class="bp-playtime-btn-label">—</span>
    </button>
  `;
  const folderLi = document.getElementById('bloxplus-add-to-folder-btn');
  if (folderLi && folderLi.parentElement === ul) {
    ul.insertBefore(li, folderLi);
  } else {
    ul.appendChild(li);
  }

  const btn = li.querySelector<HTMLButtonElement>('.bp-playtime-btn')!;
  // Hydrate label asynchronously — universe lookup + storage read.
  void hydrate(btn, placeId);

  // Live updates: service worker accumulates trackedSeconds via alarm; refresh
  // on storage change so the pill reflects the latest total without a reload.
  if (!subscribed) {
    subscribed = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes['bloxplus.playtime']) return;
      const live = document.querySelector<HTMLButtonElement>(`#${BUTTON_ID} .bp-playtime-btn`);
      const currentPlace = readPlaceId();
      if (live && currentPlace) void hydrate(live, currentPlace);
    });
  }
}

async function hydrate(btn: HTMLButtonElement, placeId: number): Promise<void> {
  const universeId = await resolveUniverseId(placeId);
  const li = btn.closest<HTMLLIElement>(`#${BUTTON_ID}`);
  if (!li?.isConnected || li.dataset.bpPlaceId !== String(placeId) || readPlaceId() !== placeId) {
    return;
  }
  if (!universeId) return;
  const entries = await getPlaytime();
  if (li.dataset.bpPlaceId !== String(placeId) || readPlaceId() !== placeId) return;
  const entry = entries.find((e) => e.universeId === universeId);
  applyButtonState(btn, entry);
}

function applyButtonState(btn: HTMLButtonElement, entry: GamePlaytimeEntry | undefined): void {
  const label = btn.querySelector<HTMLSpanElement>('.bp-playtime-btn-label');
  if (!label) return;
  const total = entry?.totalSeconds ?? 0;
  label.textContent = formatShort(total);
  btn.classList.toggle('bp-has-playtime', total > 0);
  btn.title = buildTooltip(entry);
}

/**
 * Compact pill format: prefer `Xh Ym` for >= 1h, `Xm` for < 1h, `0h` for none.
 * The badge stays visually short so it doesn't push the rest of the row.
 */
function formatShort(seconds: number): string {
  if (!seconds || seconds <= 0) return '0h';
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${Math.max(1, m)}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function buildTooltip(entry: GamePlaytimeEntry | undefined): string {
  if (!entry) return 'Lifetime playtime: no data yet';
  const lines = [`Lifetime playtime: ${formatLong(entry.totalSeconds)}`];
  if (entry.importedSeconds > 0 && entry.trackedSeconds > 0) {
    lines.push(`  Imported: ${formatLong(entry.importedSeconds)}`);
    lines.push(`  Tracked: ${formatLong(entry.trackedSeconds)}`);
  }
  if (entry.lastPlayedAt) {
    const d = new Date(entry.lastPlayedAt);
    if (Number.isFinite(d.getTime())) lines.push(`Last played: ${d.toLocaleString()}`);
  }
  return lines.join('\n');
}

function formatLong(seconds: number): string {
  if (seconds <= 0) return '0 minutes';
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m} minute${m === 1 ? '' : 's'}`;
  if (m === 0) return `${h} hour${h === 1 ? '' : 's'}`;
  return `${h} hour${h === 1 ? '' : 's'} ${m} minute${m === 1 ? '' : 's'}`;
}

async function resolveUniverseId(placeId: number): Promise<number | null> {
  if (cachedUniverseId && cachedForPlaceId === placeId) return cachedUniverseId;
  const universeId = await placeIdToUniverseId(placeId);
  if (!universeId) return null;
  cachedUniverseId = universeId;
  cachedForPlaceId = placeId;
  return universeId;
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
    .bp-playtime-btn-li {
      display: flex; align-items: center; justify-content: center;
      list-style: none;
    }
    .bp-playtime-btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 999px;
      background: rgba(255,255,255,0.04);
      color: inherit;
      font: 600 12px/1 inherit;
      cursor: default;
    }
    .bp-playtime-btn:hover { background: rgba(255,255,255,0.10); }
    .bp-playtime-btn-icon {
      display: inline-flex; align-items: center; justify-content: center;
      line-height: 0;
    }
    .bp-playtime-btn.bp-has-playtime {
      background: rgba(74,144,226,0.16);
      border-color: rgba(74,144,226,0.55);
      color: #bcd8ff;
    }
  `;
  document.head.appendChild(style);
}
