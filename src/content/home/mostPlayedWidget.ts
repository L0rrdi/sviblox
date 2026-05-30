import { getPlaytime } from '@/storage/playtimeStore';
import { setSettings } from '@/storage/settingsStore';
import { getGameInfo, GameInfo } from '@/api/games';
import { getGameIcons } from '@/api/thumbnails';
import { GamePlaytimeEntry, Settings } from '@/types';
import { escapeHtml } from '@/util/html';

const WIDGET_ID = 'bloxplus-most-played';
const STYLE_ID = 'bloxplus-most-played-style';
const MAX_TILES = 12;

type WindowKey = 'all' | 'year' | '30d' | '7d' | '24h';

const WINDOW_LABELS: Record<WindowKey, string> = {
  all: 'All time',
  year: 'Past year',
  '30d': 'Past 30 days',
  '7d': 'Past 7 days',
  '24h': 'Past 24 hours',
};

/** Cutoff in ms from now; null means no cutoff (lifetime). */
const WINDOW_MS: Record<WindowKey, number | null> = {
  all: null,
  year: 365 * 86400_000,
  '30d': 30 * 86400_000,
  '7d': 7 * 86400_000,
  '24h': 86400_000,
};

/**
 * Some windows match a key in `windowSeconds` populated by the importer
 * (RoPro stores per-window minutes for 30 and 999). Others fall back to
 * recency filtering on lastPlayedAt + totalSeconds.
 */
const WINDOW_DATA_KEY: Record<WindowKey, string | null> = {
  all: null,
  year: null,
  '30d': '30',
  '7d': null,
  '24h': null,
};

function fmtHours(seconds: number): string {
  const h = Math.round(seconds / 3600);
  if (h <= 0) {
    const m = Math.max(1, Math.round(seconds / 60));
    return `${m} min`;
  }
  return `${h.toLocaleString()} ${h === 1 ? 'hour' : 'hours'}`;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #HomeContainer .container-header.bp-host {
      position: relative;
      min-height: 170px;
    }
    #${WIDGET_ID} {
      position: absolute;
      top: -12px;
      right: 0;
      width: 640px;
      max-width: 70%;
      display: flex;
      flex-direction: column;
      gap: 6px;
      color: inherit;
      font-family: inherit;
      z-index: 2;
      pointer-events: auto;
    }
    #${WIDGET_ID} .bp-header {
      display: flex; align-items: center; justify-content: space-between;
      font-size: 14px; font-weight: 600;
    }
    #${WIDGET_ID} .bp-header .bp-title { display: flex; align-items: center; gap: 6px; }
    #${WIDGET_ID} .bp-header select {
      background: #1a1d24;
      color: #e6e6e6;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 4px;
      padding: 3px 8px;
      font-size: 12px;
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
      background-image: linear-gradient(45deg, transparent 50%, #b0b6c0 50%),
                        linear-gradient(135deg, #b0b6c0 50%, transparent 50%);
      background-position: calc(100% - 12px) 50%, calc(100% - 7px) 50%;
      background-size: 5px 5px, 5px 5px;
      background-repeat: no-repeat;
      padding-right: 22px;
    }
    #${WIDGET_ID} .bp-header select:hover { border-color: rgba(255,255,255,0.32); }
    #${WIDGET_ID} .bp-header select:focus { outline: 1px solid #4a90e2; outline-offset: -1px; }
    #${WIDGET_ID} .bp-header select option {
      background: #1a1d24;
      color: #e6e6e6;
    }
    #${WIDGET_ID} .bp-header .bp-header-actions {
      display: flex; align-items: center; gap: 6px;
    }
    #${WIDGET_ID} .bp-visibility-toggle {
      width: 28px; height: 28px;
      display: inline-flex; align-items: center; justify-content: center;
      padding: 0;
      background: #1a1d24;
      color: #e6e6e6;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 4px;
      cursor: pointer;
    }
    #${WIDGET_ID} .bp-visibility-toggle:hover { border-color: rgba(255,255,255,0.32); }
    #${WIDGET_ID} .bp-visibility-toggle svg {
      width: 16px; height: 16px;
      display: block;
      pointer-events: none;
    }
    #${WIDGET_ID} .bp-visibility-toggle svg .bp-eye-pupil,
    #${WIDGET_ID} .bp-visibility-toggle svg .bp-eye-shape,
    #${WIDGET_ID} .bp-visibility-toggle svg .bp-eye-parts {
      transform-box: fill-box;
      transform-origin: 50% 50%;
      transition: transform 0.18s ease-out, opacity 0.18s ease-out;
    }
    #${WIDGET_ID} .bp-visibility-toggle:hover svg .bp-eye-pupil { transform: scale(0.7); }
    #${WIDGET_ID} .bp-visibility-toggle:hover svg .bp-eye-shape { transform: scaleY(0.9); }
    #${WIDGET_ID} .bp-visibility-toggle:hover svg .bp-eye-parts {
      transform: scale(0.98); opacity: 0.6;
    }
    /* When the eye-off icon is shown the strike line should be fully drawn
     * (that's what conveys "off"). The animation only plays once on first
     * paint of the icon so swapping back to the open eye doesn't strobe. */
    #${WIDGET_ID} .bp-visibility-toggle svg .bp-eye-strike {
      stroke-dasharray: 30;
      stroke-dashoffset: 0;
      animation: bp-eye-strike-draw 0.28s ease-out both;
    }
    @keyframes bp-eye-strike-draw {
      from { stroke-dashoffset: 30; opacity: 0.5; }
      to   { stroke-dashoffset: 0;  opacity: 1; }
    }
    /* Collapsed: drop everything except the toggle button so the user can
     * always find it. The button gets a clear text label appended so it's
     * unambiguous. The title and time-window dropdown both disappear. */
    #${WIDGET_ID}.bp-mp-hidden .bp-meta,
    #${WIDGET_ID}.bp-mp-hidden .bp-scroll,
    #${WIDGET_ID}.bp-mp-hidden .bp-window,
    #${WIDGET_ID}.bp-mp-hidden .bp-title {
      display: none;
    }
    #${WIDGET_ID}.bp-mp-hidden { gap: 0; }
    #${WIDGET_ID}.bp-mp-hidden .bp-header {
      justify-content: flex-end;
    }
    #${WIDGET_ID}.bp-mp-hidden .bp-visibility-toggle {
      width: auto;
      padding: 4px 10px 4px 8px;
      gap: 6px;
    }
    #${WIDGET_ID}.bp-mp-hidden .bp-visibility-toggle::after {
      content: 'Show Most Played';
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.2px;
    }
    #${WIDGET_ID} .bp-meta { font-weight: 400; font-size: 11px; opacity: 0.55; margin-top: -2px; }
    #${WIDGET_ID} .bp-scroll {
      position: relative;
    }
    #${WIDGET_ID} .bp-row {
      display: flex; gap: 10px; overflow-x: auto; padding: 2px 0 0 0;
      scrollbar-width: none;
      scroll-behavior: smooth;
    }
    #${WIDGET_ID} .bp-row::-webkit-scrollbar { display: none; }
    #${WIDGET_ID} .bp-arrow {
      position: absolute; top: calc(50% - 20px);
      width: 40px; height: 40px; border-radius: 50%;
      background: rgb(25,26,31); color: rgb(247,247,248); border: none;
      cursor: pointer; font-size: 28px; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      opacity: 0; transition: opacity 0.15s ease, background-color 0.15s ease;
      box-shadow: 0 1px 4px rgba(0,0,0,0.35);
      z-index: 5;
      padding: 0;
    }
    #${WIDGET_ID} .bp-scroll:hover .bp-arrow { opacity: 0.9; }
    #${WIDGET_ID} .bp-arrow:hover { background: rgb(36,37,43); opacity: 1; }
    #${WIDGET_ID} .bp-arrow[hidden] { display: none; }
    #${WIDGET_ID} .bp-arrow.bp-left { left: -12px; }
    #${WIDGET_ID} .bp-arrow.bp-right { right: -12px; }
    #${WIDGET_ID} .bp-arrow .icon-chevron-heavy-left,
    #${WIDGET_ID} .bp-arrow .icon-chevron-heavy-right {
      width: 28px; height: 28px;
      display: inline-block;
      pointer-events: none;
    }
    #${WIDGET_ID} .bp-tile {
      flex: 0 0 auto; width: 100px; text-decoration: none; color: inherit;
    }
    #${WIDGET_ID} .bp-tile img {
      width: 100px; height: 100px; border-radius: 8px; background: #2a2d35;
      object-fit: cover; display: block;
    }
    #${WIDGET_ID} .bp-tile .bp-name {
      font-size: 12px; font-weight: 500; margin-top: 5px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #${WIDGET_ID} .bp-tile .bp-time {
      font-size: 11px; opacity: 0.7; margin-top: 1px;
    }
    #${WIDGET_ID} .bp-empty { font-size: 13px; opacity: 0.7; padding: 12px 0; }
  `;
  document.head.appendChild(style);
}

function isHomePage(): boolean {
  const p = location.pathname;
  return p === '/' || p === '/home' || p.startsWith('/home');
}

function findHeadingRow(): HTMLElement | null {
  const root = document.getElementById('HomeContainer');
  if (!root) return null;
  // Primary: any `<h1>` inside #HomeContainer's first .container-header is
  // the page title row regardless of what it says (Norwegian "Hjem",
  // Spanish "Inicio", etc. all hit). Falls back to just the first
  // container-header if the h1 lookup misses, which still places the widget
  // in the right spot.
  const containerHeader = root.querySelector('.container-header');
  if (containerHeader instanceof HTMLElement && containerHeader.querySelector('h1')) {
    return containerHeader;
  }
  return containerHeader instanceof HTMLElement ? containerHeader : null;
}

interface WidgetState {
  all: GamePlaytimeEntry[];
  info: Map<number, GameInfo>;
  icons: Map<number, string>;
  currentWindow: WindowKey;
  destroyed: boolean;
}

let widget: HTMLElement | null = null;
let state: WidgetState | null = null;
let playtimeSubscribed = false;
const activeScrollAnimations = new WeakMap<HTMLElement, number>();

/**
 * Live-refresh hook: the SW per-minute presence accumulator writes to
 * `bloxplus.playtime` while the user has the home page open. Without
 * this, tracked time only shows up after a navigation away and back.
 * Subscription is installed once at module level (idempotent) and only
 * does work while the widget is mounted.
 */
function ensurePlaytimeSubscription(): void {
  if (playtimeSubscribed) return;
  playtimeSubscribed = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes['bloxplus.playtime']) return;
    if (!widget || !state || state.destroyed) return;
    void refreshFromStorage();
  });
}

async function refreshFromStorage(): Promise<void> {
  if (!widget || !state || state.destroyed) return;
  const next = await getPlaytime();
  if (!state || state.destroyed) return;
  state.all = next;
  // Hydrate info/icons for any newly-seen universeIds whose top totalSeconds
  // would put them inside MAX_TILES. We don't refetch already-known ids.
  const ranked = rankedUniverseIds(next);
  const missing = ranked.filter((id) => !state!.info.has(id)).slice(0, 50);
  if (missing.length) {
    try {
      const [info, icons] = await Promise.all([getGameInfo(missing), getGameIcons(missing)]);
      if (!state || state.destroyed) return;
      for (const [id, gi] of info) state.info.set(id, gi);
      for (const [id, url] of icons) state.icons.set(id, url);
    } catch {
      // Render what we have.
    }
  }
  renderTiles();
}

export async function run(settings: Settings): Promise<void> {
  if (!isHomePage()) {
    cleanup();
    return;
  }

  ensureStyle();

  if (!settings.playtimeTracker) {
    cleanup();
    return;
  }

  const row = await waitFor(findHeadingRow, 5000);
  if (!row) return;
  row.classList.add('bp-host');

  // Idempotent: if widget already mounted, just make sure it's parented to
  // the current heading row (in case React replaced it) and re-sync the
  // visibility toggle against the latest setting (so popup toggles take
  // effect on the next tick), then exit.
  if (widget && document.contains(widget)) {
    if (widget.parentElement !== row) row.appendChild(widget);
    applyVisibility(widget, settings.hideMostPlayedWidget === true);
    return;
  }

  // Build skeleton.
  widget = document.createElement('div');
  widget.id = WIDGET_ID;
  widget.innerHTML = `
    <div class="bp-header">
      <div class="bp-title">
        <span>Your Most Played</span>
      </div>
      <div class="bp-header-actions">
        <select class="bp-window" aria-label="Time window">
          ${(Object.keys(WINDOW_LABELS) as WindowKey[])
            .map((k) => `<option value="${k}">${WINDOW_LABELS[k]}</option>`)
            .join('')}
        </select>
        <button type="button" class="bp-visibility-toggle" aria-label="Hide Most Played widget" aria-pressed="false"></button>
      </div>
    </div>
    <div class="bp-meta"></div>
    <div class="bp-scroll">
      <button type="button" class="bp-arrow bp-left scroller-new prev" aria-label="Scroll left" hidden><span class="icon-chevron-heavy-left" aria-hidden="true"></span></button>
      <div class="bp-row"></div>
      <button type="button" class="bp-arrow bp-right scroller-new next" aria-label="Scroll right" hidden><span class="icon-chevron-heavy-right" aria-hidden="true"></span></button>
    </div>
  `;
  row.appendChild(widget);
  applyVisibility(widget, settings.hideMostPlayedWidget === true);
  wireVisibilityToggle(widget);

  const all = await getPlaytime();
  const initialWindow = (settings.homeWidgetWindow in WINDOW_LABELS
    ? settings.homeWidgetWindow
    : 'all') as WindowKey;
  state = { all, info: new Map(), icons: new Map(), currentWindow: initialWindow, destroyed: false };
  ensurePlaytimeSubscription();

  // Prefetch info/icons for the top tracked games by playtime so the user's
  // most-played tiles render hydrated regardless of how many games they have.
  const ids = rankedUniverseIds(all).slice(0, 200);
  void Promise.all([getGameInfo(ids), getGameIcons(ids)]).then(([info, icons]) => {
    if (!state || state.destroyed) return;
    state.info = info;
    state.icons = icons;
    renderTiles();
  });

  // Wire up window dropdown.
  const sel = widget.querySelector('.bp-window') as HTMLSelectElement;
  sel.value = state.currentWindow;
  sel.addEventListener('change', () => {
    if (!state) return;
    state.currentWindow = sel.value as WindowKey;
    void setSettings({ homeWidgetWindow: state.currentWindow });
    renderTiles();
  });

  // Arrow scroll.
  const scrollEl = widget.querySelector('.bp-row') as HTMLElement;
  widget.querySelector('.bp-left')!.addEventListener('click', () =>
    scrollMostPlayedRow(scrollEl, -1)
  );
  widget.querySelector('.bp-right')!.addEventListener('click', () =>
    scrollMostPlayedRow(scrollEl, 1)
  );
  bindMostPlayedArrowState(widget, scrollEl);

  renderTiles();
}

export function cleanup(): void {
  if (widget) {
    widget.remove();
    widget = null;
  }
  if (state) state.destroyed = true;
  state = null;
}

const EYE_SVG = `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path class="bp-eye-pupil" d="M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"></path>
    <path class="bp-eye-shape" d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"></path>
  </svg>
`;

const EYE_OFF_SVG = `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <g class="bp-eye-parts">
      <path d="M10.585 10.587a2 2 0 0 0 2.829 2.828"></path>
      <path d="M16.681 16.673a8.717 8.717 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674m2.86 -1.146a9.055 9.055 0 0 1 1.82 -.18c3.6 0 6.6 2 9 6c-.666 1.11 -1.379 2.067 -2.138 2.87"></path>
    </g>
    <path class="bp-eye-strike" d="M3 3l18 18"></path>
  </svg>
`;

function applyVisibility(widgetEl: HTMLElement, hidden: boolean): void {
  widgetEl.classList.toggle('bp-mp-hidden', hidden);
  const btn = widgetEl.querySelector<HTMLButtonElement>('.bp-visibility-toggle');
  if (!btn) return;
  btn.setAttribute('aria-pressed', String(hidden));
  btn.setAttribute(
    'aria-label',
    hidden ? 'Show Most Played widget' : 'Hide Most Played widget'
  );
  btn.title = hidden ? 'Show Most Played' : 'Hide Most Played';
  // Swap the SVG only when the state actually changes. Compare against the
  // wanted state (not the inverse of the previous one) so the first call
  // — where `bpEyeState` is undefined — always injects.
  const wanted = hidden ? 'off' : 'on';
  if (btn.dataset.bpEyeState !== wanted) {
    btn.innerHTML = wanted === 'off' ? EYE_OFF_SVG : EYE_SVG;
    btn.dataset.bpEyeState = wanted;
  }
}

function wireVisibilityToggle(widgetEl: HTMLElement): void {
  const btn = widgetEl.querySelector<HTMLButtonElement>('.bp-visibility-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const next = !widgetEl.classList.contains('bp-mp-hidden');
    applyVisibility(widgetEl, next);
    void setSettings({ hideMostPlayedWidget: next });
  });
}

function bindMostPlayedArrowState(widgetEl: HTMLElement, row: HTMLElement): void {
  if (row.dataset.bpArrowObs) return;
  row.dataset.bpArrowObs = '1';
  let raf = 0;
  const schedule = (): void => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      updateMostPlayedArrows(widgetEl);
    });
  };
  row.addEventListener('scroll', schedule, { passive: true });
  new ResizeObserver(schedule).observe(row);
  new MutationObserver(schedule).observe(row, { childList: true });
  schedule();
}

function updateMostPlayedArrows(widgetEl: HTMLElement): void {
  const row = widgetEl.querySelector('.bp-row');
  const left = widgetEl.querySelector('.bp-left');
  const right = widgetEl.querySelector('.bp-right');
  if (
    !(row instanceof HTMLElement) ||
    !(left instanceof HTMLElement) ||
    !(right instanceof HTMLElement)
  ) {
    return;
  }
  const max = row.scrollWidth - row.clientWidth;
  const scrollable = max > 1;
  left.hidden = !scrollable || row.scrollLeft <= 1;
  right.hidden = !scrollable || row.scrollLeft >= max - 1;
}

function scrollMostPlayedRow(row: HTMLElement, direction: -1 | 1): void {
  const max = Math.max(0, row.scrollWidth - row.clientWidth);
  const amount = Math.max(320, Math.floor(row.clientWidth * 0.85));
  animateMostPlayedScroll(row, Math.min(max, Math.max(0, row.scrollLeft + direction * amount)));
}

function animateMostPlayedScroll(row: HTMLElement, target: number): void {
  const previous = activeScrollAnimations.get(row);
  if (previous) cancelAnimationFrame(previous);

  const start = row.scrollLeft;
  const delta = target - start;
  if (Math.abs(delta) < 1) return;

  const duration = 420;
  const startedAt = performance.now();
  const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
  const tick = (now: number): void => {
    const progress = Math.min(1, (now - startedAt) / duration);
    row.scrollLeft = start + delta * easeOutCubic(progress);
    if (progress < 1) {
      activeScrollAnimations.set(row, requestAnimationFrame(tick));
      return;
    }
    activeScrollAnimations.delete(row);
  };
  activeScrollAnimations.set(row, requestAnimationFrame(tick));
}

function passesRecency(e: GamePlaytimeEntry, w: WindowKey): boolean {
  const ms = WINDOW_MS[w];
  if (ms === null) return true;
  if (!e.lastPlayedAt) return false;
  const t = Date.parse(e.lastPlayedAt);
  return Number.isFinite(t) && t >= Date.now() - ms;
}

function secondsForWindow(e: GamePlaytimeEntry, w: WindowKey): number {
  const dk = WINDOW_DATA_KEY[w];
  if (dk !== null) return e.windowSeconds?.[dk] ?? 0;
  // No per-window data: only count if active in the window, then use total.
  return passesRecency(e, w) ? e.totalSeconds : 0;
}

function renderTiles(): void {
  if (!widget || !state) return;
  const w = state.currentWindow;
  const ranked = state.all
    .map((e) => ({ e, sec: secondsForWindow(e, w) }))
    .filter((r) => r.sec > 0)
    .sort((a, b) => b.sec - a.sec);
  const top = ranked.slice(0, MAX_TILES);

  const meta = widget.querySelector('.bp-meta') as HTMLElement;
  const totalSec = ranked.reduce((s, r) => s + r.sec, 0);
  const hasExplicitWindow = WINDOW_DATA_KEY[w] !== null || w === 'all';
  const note = hasExplicitWindow
    ? WINDOW_LABELS[w].toLowerCase()
    : `active in ${WINDOW_LABELS[w].toLowerCase()} (lifetime hours shown)`;
  meta.textContent = `${ranked.length} games · ${fmtHours(totalSec)} · ${note}`;

  const rowEl = widget.querySelector('.bp-row') as HTMLElement;
  if (!top.length) {
    rowEl.innerHTML = `<div class="bp-empty">No games tracked in this window.</div>`;
    updateMostPlayedArrows(widget);
    return;
  }

  rowEl.innerHTML = top
    .map(({ e, sec }) => {
      const id = e.universeId;
      const info = id ? state!.info.get(id) : undefined;
      const icon = id ? state!.icons.get(id) : undefined;
      const name = info?.name ?? e.gameName ?? `#${id}`;
      const placeId = info?.rootPlaceId ?? e.placeId;
      const href = placeId
        ? `https://www.roblox.com/games/${placeId}`
        : id
        ? `https://www.roblox.com/games/?Keyword=${id}`
        : '#';
      return `
        <a class="bp-tile" href="${href}">
          <img src="${icon ?? ''}" alt="${escapeHtml(name)}" loading="lazy" />
          <div class="bp-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
          <div class="bp-time">${fmtHours(sec)}</div>
        </a>
      `;
    })
    .join('');
  updateMostPlayedArrows(widget);
}

/**
 * Universe IDs ranked by max totalSeconds desc. Used for the bounded
 * prefetch — heavy users with >200 tracked games must get their most-played
 * tiles hydrated first, otherwise sorting ascending by ID hydrates the
 * lowest-ID 200 games and the actual top tiles render iconless/nameless.
 */
function rankedUniverseIds(entries: GamePlaytimeEntry[]): number[] {
  const byId = new Map<number, number>();
  for (const e of entries) {
    if (typeof e.universeId !== 'number') continue;
    const prev = byId.get(e.universeId) ?? 0;
    const cur = e.totalSeconds ?? 0;
    if (cur > prev) byId.set(e.universeId, cur);
  }
  return [...byId.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

async function waitFor<T>(fn: () => T | null, timeoutMs: number): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;

}
