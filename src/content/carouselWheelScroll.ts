/**
 * Wheel-to-arrow on horizontal carousels.
 *
 * Rolling the mouse wheel UP over a carousel scrolls it right (same as its
 * right / "next" arrow); rolling DOWN scrolls it left (the left / "prev"
 * arrow) — so you don't have to chase the small hover arrows with the cursor.
 * One wheel notch ≈ one arrow click (we use the wheel's *direction* only, not
 * its magnitude, so the feel matches clicking the arrow).
 *
 * Two carousel families are handled:
 *
 *  - SviBlox's own home rows (Favorites / My Games / Folders → `.bp-fav-row`
 *    inside `.bp-fav-scroll`; Most Played → `.bp-row` inside `.bp-scroll`).
 *    These are real overflow scrollers, so we animate `scrollLeft`. Robust.
 *
 *  - Roblox's native `.horizontal-scroller` carousels (Continue / Recommended /
 *    charts). These are NOT real scrollers — the row position is a JS-managed
 *    CSS `left` on `.horizontally-scrollable`, and the native arrows only fire
 *    on TRUSTED clicks (synthetic clicks, direct React onClick, and synthetic
 *    wheel events were all verified to do nothing). So this is best-effort: we
 *    animate `left` ourselves with *plain inline* styles (never `!important`),
 *    which means Roblox's own arrow-click writes still override ours and the
 *    native arrows keep working. We only "win" for the duration of a wheel
 *    gesture. A native resize/re-render can snap Roblox's row back to its own
 *    page state, so the two can briefly desync — acceptable for best-effort.
 *
 * We only swallow the wheel (preventDefault) when the carousel can actually
 * move in that direction; at either extent the event passes through so the page
 * scrolls normally instead of feeling stuck.
 *
 * The feature is OFF by default and is gated behind a hold-to-activate key
 * (`settings.carouselScrollHoldKey`, bound in the popup's Hotkeys panel). It
 * only translates the wheel while that key is physically held; with no key
 * bound the wheel listener is a no-op and the wheel behaves normally.
 */

import { getSettings, onSettingsChanged } from '@/storage/settingsStore';

const STEP_MIN = 420;
const STEP_RATIO = 0.85;
const DURATION_MS = 380;

interface Mover {
  /** Stable element used as the animation key. */
  key: HTMLElement;
  /** Current scroll offset, 0..max (always non-negative). */
  get: () => number;
  /** Apply a scroll offset (0..max). */
  set: (offset: number) => void;
  /** Largest valid offset. */
  max: () => number;
  /** Pixels to move per wheel notch. */
  step: () => number;
}

interface Anim {
  raf: number;
  target: number;
}

const STYLE_ID = 'bp-carousel-wheel-style';
const ACTIVE_CLASS = 'bp-cws-active';

const anims = new WeakMap<HTMLElement, Anim>();
let installed = false;

/** The bound hold-to-activate key (lowercase), or '' when the feature is off. */
let holdKey = '';
/** Keys currently held down (tracked so we know when `holdKey` is pressed). */
const heldKeys = new Set<string>();

let listenersAttached = false;

export function install(): void {
  if (installed) return;
  installed = true;

  ensureStyle();

  void getSettings().then((s) => {
    holdKey = normalizeHoldKey(s.carouselScrollHoldKey);
    syncListeners();
  });
  onSettingsChanged((s) => {
    holdKey = normalizeHoldKey(s.carouselScrollHoldKey);
    if (!holdKey) heldKeys.clear();
    refreshActive();
    syncListeners();
  });
}

/**
 * Attach the wheel/key listeners ONLY while a hold key is bound. The wheel
 * listener has to be non-passive (it preventDefaults to lock page scroll while
 * the key is held), and a non-passive document wheel listener forces main-
 * thread scrolling + can inhibit compositor optimizations like video-overlay
 * promotion — so leaving it attached when the feature is off (no key bound, the
 * default) needlessly hurt video-background FPS for zero benefit. Binding a key
 * attaches them; clearing the binding removes them.
 */
function syncListeners(): void {
  const want = !!holdKey;
  if (want === listenersAttached) return;
  listenersAttached = want;
  if (want) {
    // Capture phase so we still see events even when something stops
    // propagation; blur clears so a key can't "stick" down.
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('wheel', onWheel, { capture: true, passive: false });
  } else {
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('wheel', onWheel, { capture: true });
    heldKeys.clear();
    refreshActive();
  }
}

function onBlur(): void {
  heldKeys.clear();
  refreshActive();
}

function normalizeHoldKey(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function isActive(): boolean {
  return !!holdKey && heldKeys.has(holdKey);
}

/**
 * Mirrors the hold state onto `<html>`. The class drives the injected CSS that
 * suppresses Roblox's white `:focus-visible` outline (which otherwise draws a
 * "white bar" around the focused scroll root when a key is held).
 */
function refreshActive(): void {
  document.documentElement.classList.toggle(ACTIVE_CLASS, isActive());
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  // While the hold key is down, kill the focus ring (Roblox styles `body` /
  // `#content` `:focus-visible` with a 3px near-white outline, so holding a key
  // paints a bar around the page). Transient — only while the gesture key is held.
  style.textContent = `
    html.${ACTIVE_CLASS},
    html.${ACTIVE_CLASS} :focus,
    html.${ACTIVE_CLASS} :focus-visible { outline: none !important; }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function onKeyDown(e: KeyboardEvent): void {
  if (holdKey && e.key.toLowerCase() === holdKey) {
    heldKeys.add(holdKey);
    refreshActive();
    // Drop focus so no element paints a `:focus-visible` ring (Roblox draws a
    // white one — the "white bar around the page" when a page-sized element is
    // focused). The CSS net above is a backup; blurring is what actually kills
    // a `outline: auto` UA ring that CSS can be raced by. Mirrors
    // hotkeysEnhancer.blurActive — see the `:focus-visible` gotcha.
    blurActive();
  }
}

function blurActive(): void {
  const el = document.activeElement;
  if (el instanceof HTMLElement && el !== document.body) el.blur();
}

function onKeyUp(e: KeyboardEvent): void {
  if (heldKeys.delete(e.key.toLowerCase())) refreshActive();
}

function onWheel(e: WheelEvent): void {
  // Off unless a hold key is bound and currently pressed.
  if (!isActive()) return;
  if (e.ctrlKey) return; // leave ctrl+wheel zoom alone
  // While the key is held the page is locked — the wheel only ever drives
  // carousels, never the page. preventDefault unconditionally so vertical page
  // scroll is fully blocked even off a carousel or at a carousel's extent.
  e.preventDefault();
  if (e.deltaY === 0) return;
  // Horizontal trackpad gestures already scroll real rows natively — don't
  // fight them; only translate a dominant-vertical wheel.
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;

  const mover = resolveMover(e.target);
  if (!mover) return;
  const max = mover.max();
  if (max <= 1) return;

  // Wheel up (deltaY < 0) → right / next (+1); wheel down → left / prev (-1).
  const direction = e.deltaY < 0 ? 1 : -1;
  // Continue from the in-flight animation target so fast spins accumulate.
  const from = anims.get(mover.key)?.target ?? mover.get();
  if (direction > 0 && from >= max - 1) return; // already at the right end
  if (direction < 0 && from <= 1) return; // already at the left end

  e.preventDefault();
  animateTo(mover, from + direction * mover.step());
}

function resolveMover(target: EventTarget | null): Mover | null {
  if (!(target instanceof Element)) return null;

  // Native Roblox carousel (best-effort `left` animation).
  const native = target.closest('.horizontal-scroller');
  if (native) {
    const inner = native.querySelector<HTMLElement>('.horizontally-scrollable');
    const win = native.querySelector<HTMLElement>('.horizontal-scroll-window');
    return inner && win ? leftMover(inner, win) : null;
  }

  // SviBlox Favorites / My Games / Folders rows.
  const favScroll = target.closest('.bp-fav-scroll');
  if (favScroll) {
    const row = favScroll.querySelector<HTMLElement>('.bp-fav-row');
    if (row) return scrollMover(row);
  }

  // SviBlox Most Played widget row.
  const mpScroll = target.closest('.bp-scroll');
  if (mpScroll) {
    const row = mpScroll.querySelector<HTMLElement>('.bp-row');
    if (row) return scrollMover(row);
  }

  return null;
}

/** Real overflow scroller: drive `scrollLeft`. */
function scrollMover(el: HTMLElement): Mover {
  return {
    key: el,
    get: () => el.scrollLeft,
    set: (offset) => {
      el.scrollLeft = offset;
    },
    max: () => Math.max(0, el.scrollWidth - el.clientWidth),
    step: () => Math.max(STEP_MIN, Math.floor(el.clientWidth * STEP_RATIO)),
  };
}

/**
 * Native `.horizontal-scroller`: the visible offset is `-left` on the inner
 * `.horizontally-scrollable`. We read/write plain inline `left` (no
 * `!important`) so Roblox's own arrow clicks still override us.
 */
function leftMover(inner: HTMLElement, win: HTMLElement): Mover {
  const readLeft = (): number => {
    const raw = inner.style.left || getComputedStyle(inner).left;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    key: inner,
    get: () => Math.max(0, -readLeft()),
    set: (offset) => {
      inner.style.left = `${-offset}px`;
    },
    max: () => Math.max(0, inner.scrollWidth - win.clientWidth),
    step: () => Math.max(STEP_MIN, Math.floor(win.clientWidth * STEP_RATIO)),
  };
}

function animateTo(mover: Mover, rawTarget: number): void {
  const target = Math.min(mover.max(), Math.max(0, rawTarget));
  const prev = anims.get(mover.key);
  if (prev) cancelAnimationFrame(prev.raf);

  const start = mover.get();
  const delta = target - start;
  if (Math.abs(delta) < 1) {
    mover.set(target);
    anims.delete(mover.key);
    return;
  }

  const startedAt = performance.now();
  const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
  const tick = (now: number): void => {
    const progress = Math.min(1, (now - startedAt) / DURATION_MS);
    mover.set(start + delta * easeOutCubic(progress));
    if (progress < 1) {
      anims.set(mover.key, { raf: requestAnimationFrame(tick), target });
    } else {
      anims.delete(mover.key);
    }
  };
  anims.set(mover.key, { raf: requestAnimationFrame(tick), target });
}
