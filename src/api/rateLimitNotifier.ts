/**
 * Tiny global rate-limit signal. `robloxFetch`/`robloxPost` call
 * `notifyRateLimited(delayMs)` whenever Roblox returns 429 and they back off, so
 * any UI can show "you're being rate-limited, retrying in Ns" instead of a
 * silent wall of failed requests. Generic + dependency-free; subscribers decide
 * whether/where to surface it (today: the Badger Hub page during heavy scans).
 */

export interface RateLimitState {
  /** Epoch ms until which we're backing off; 0 = not currently limited. */
  blockedUntil: number;
  /** 429s seen in the current burst (reset after a quiet gap). */
  hits: number;
}

type Listener = (state: RateLimitState) => void;

let blockedUntil = 0;
let hits = 0;
let clearTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

export function getRateLimitState(): RateLimitState {
  return { blockedUntil, hits };
}

export function onRateLimit(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Called by the API client when a 429 forces a `delayMs` backoff. */
export function notifyRateLimited(delayMs: number): void {
  blockedUntil = Math.max(blockedUntil, Date.now() + delayMs);
  hits += 1;
  emit();
  // Auto-clear once the burst goes quiet (no new 429 within the backoff + grace).
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    blockedUntil = 0;
    hits = 0;
    clearTimer = null;
    emit();
  }, delayMs + 1500);
}

function emit(): void {
  const state = getRateLimitState();
  for (const l of listeners) {
    try {
      l(state);
    } catch {
      /* a bad subscriber shouldn't break the others */
    }
  }
}
