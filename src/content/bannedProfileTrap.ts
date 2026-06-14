/**
 * Always-on capture-phase click listener that stashes any clicked
 * `/users/{id}/profile` userId in sessionStorage. Lets
 * terminatedProfileEnhancer recover the userId after Roblox redirects
 * a banned profile to /request-error.
 *
 * Installed from router.ts on module load (and idempotently re-called
 * from terminatedProfileEnhancer.run() as a belt-and-suspenders pass)
 * so it's listening site-wide before any click can happen.
 */

const SESSION_KEY = 'bp.lastProfileNav';
const CLICK_FLAG = '__bpBannedClickInstalled';
const STALE_MS = 30_000;

export function install(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w[CLICK_FLAG]) return;
  w[CLICK_FLAG] = true;
  document.addEventListener(
    'click',
    (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href*="/users/"]');
      if (!a) return;
      const href = a.getAttribute('href') ?? '';
      const m = href.match(/\/users\/(\d+)\/profile/);
      if (!m) return;
      const id = Number(m[1]);
      if (!Number.isFinite(id)) return;
      writeRecentProfileNav(id);
    },
    true
  );
}

export function writeRecentProfileNav(id: number): void {
  if (!Number.isFinite(id)) return;
  try {
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ id, ts: Date.now() })
    );
  } catch {
    /* private mode etc. */
  }
}

export function readRecentProfileNav(): number | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const { id, ts } = JSON.parse(raw) as { id?: number; ts?: number };
    if (typeof id !== 'number' || typeof ts !== 'number') return null;
    if (Date.now() - ts > STALE_MS) return null;
    return id;
  } catch {
    return null;
  }
}

export async function readRecentProfileNavForCurrentTab(): Promise<number | null> {
  const local = readRecentProfileNav();
  if (local) return local;

  try {
    const resp = (await chrome.runtime.sendMessage({
      type: 'bp-read-recent-profile-nav',
    })) as { ok?: boolean; id?: number } | undefined;
    const id = resp?.ok && typeof resp.id === 'number' ? resp.id : null;
    if (!id) return null;
    writeRecentProfileNav(id);
    return id;
  } catch {
    return null;
  }
}
