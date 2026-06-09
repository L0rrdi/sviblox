/**
 * One-time "someone un-added you" popup.
 *
 * Once per page load, fetches the authenticated user's current friend list
 * (fresh, bypassing the 5-minute cache), diffs it against the last known-good
 * snapshot (`friendsSnapshotStore`), and queues anyone who has vanished as a
 * pending removal. If there are pending removals it shows an "Unfriend
 * Detected" modal listing them; dismissing (Ok / ✕) clears the queue.
 *
 * Accuracy guards (false "X removed you" is socially harmful, so err toward
 * silence):
 *  - Only runs when signed in.
 *  - Never re-baselines on a failed/empty fetch — an empty result against a
 *    non-empty snapshot is treated as a network hiccup, not a mass unfriend, so
 *    the snapshot is left untouched and nothing is reported.
 *  - First run for an account just records a baseline silently (no popup).
 *  - Confirmed-banned accounts are excluded (a ban isn't an un-add). Deleted /
 *    unresolvable accounts are kept (unknown → report, to avoid missing a real
 *    removal on a transient error).
 *
 * Limitation: Roblox friendships are mutual, so a vanished friend means the
 * link ended — we cannot tell whether they removed you or you removed them
 * (e.g. from another device). This is the same limitation every unfriend
 * detector has. Gated by `settings.showFriendRemovals`.
 */

import { getSettings } from '@/storage/settingsStore';
import { getAuthenticatedUserId, getRobloxUser, getCombinedNames } from '@/api/users';
import { getMyFriends, FriendRow } from '@/api/friends';
import {
  getFriendSnapshot,
  setFriendSnapshot,
  getPendingRemovals,
  addPendingRemovals,
  clearPendingRemovals,
  RemovedFriend,
} from '@/storage/friendsSnapshotStore';
import { escapeHtml } from '@/util/html';

const MODAL_ID = 'bloxplus-friend-removal-modal';
const STYLE_ID = 'bloxplus-friend-removal-style';

let checkedThisLoad = false;
let modalShownThisSession = false;
let activeUserId: number | null = null;

export function run(): void {
  void runAsync();
}

async function runAsync(): Promise<void> {
  const settings = await getSettings();
  if (!settings.showFriendRemovals) return;

  if (!checkedThisLoad) {
    checkedThisLoad = true;
    await detect();
  }

  if (!modalShownThisSession) await maybeShowModal();
}

async function detect(): Promise<void> {
  const uid = await getAuthenticatedUserId();
  if (!uid) return;
  activeUserId = uid;

  let current: FriendRow[];
  try {
    current = await getMyFriends(uid, { forceRefresh: true });
  } catch {
    return; // network failure — leave the snapshot + pending queue untouched
  }

  const snapshot = await getFriendSnapshot(uid);

  // First run for this account: record a baseline, never pop up retroactively.
  if (!snapshot) {
    await setFriendSnapshot(uid, current);
    return;
  }

  // An empty result against a previously non-empty list is almost certainly a
  // failed/blocked fetch, not a mass unfriend — don't re-baseline or report.
  const priorIds = Object.keys(snapshot.friends).map(Number);
  if (current.length === 0 && priorIds.length > 0) return;

  const currentIds = new Set(current.map((f) => f.id));
  const removedIds = priorIds.filter((id) => !currentIds.has(id));

  // Refresh the snapshot to the fresh truth before anything else can fail.
  await setFriendSnapshot(uid, current);

  if (removedIds.length === 0) return;

  const removed = await resolveRemoved(removedIds, snapshot.friends);
  if (removed.length) await addPendingRemovals(uid, removed);
}

/** Builds display rows for removed ids, filling blank names and dropping bans. */
async function resolveRemoved(
  removedIds: number[],
  prior: Record<number, { name: string; displayName?: string }>
): Promise<RemovedFriend[]> {
  // Hydrate any names that were blank in the snapshot (the friends endpoint
  // sometimes returns empty name/displayName).
  const needNames = removedIds.filter((id) => !prior[id]?.name && !prior[id]?.displayName);
  const hydrated = needNames.length ? await getCombinedNames(needNames).catch(() => null) : null;

  const out: RemovedFriend[] = [];
  for (const id of removedIds) {
    // Exclude confirmed-banned accounts — a termination isn't an un-add.
    try {
      const user = await getRobloxUser(id);
      if (user?.isBanned) continue;
    } catch {
      // unresolved → keep (don't miss a real removal on a transient error)
    }

    const snap = prior[id];
    const combined = hydrated?.get(id);
    const username = snap?.name || combined?.names.username || '';
    const displayName = snap?.displayName || combined?.names.combinedName || username || `User ${id}`;
    out.push({ id, name: username, displayName });
  }
  return out;
}

async function maybeShowModal(): Promise<void> {
  if (document.getElementById(MODAL_ID)) return;
  const uid = activeUserId ?? (await getAuthenticatedUserId());
  if (!uid) return;
  activeUserId = uid;

  const pending = await getPendingRemovals(uid);
  if (!pending.length) return;

  modalShownThisSession = true;
  mountModal(pending, uid);
}

function mountModal(removed: RemovedFriend[], uid: number): void {
  ensureStyle();

  const names = removed
    .map((r) => {
      const label = r.displayName || r.name || `User ${r.id}`;
      return `<a class="bp-frn-name" href="/users/${r.id}/profile">${escapeHtml(label)}</a>`;
    })
    .join('<span class="bp-frn-sep">, </span>');

  const wrap = document.createElement('div');
  wrap.id = MODAL_ID;
  wrap.className = 'bp-frn-wrap';
  wrap.innerHTML = `
    <div class="bp-frn-backdrop" data-bp-frn-close></div>
    <div class="bp-frn-modal" role="alertdialog" aria-labelledby="bp-frn-title">
      <div class="bp-frn-head">
        <span class="bp-frn-title" id="bp-frn-title">Unfriend Detected</span>
        <button type="button" class="bp-frn-x" data-bp-frn-close aria-label="Close">&times;</button>
      </div>
      <div class="bp-frn-body">
        You have been un-friended by the following ${
          removed.length === 1 ? 'person' : 'people'
        }: <span class="bp-frn-names">${names}</span>
      </div>
      <div class="bp-frn-actions">
        <button type="button" class="bp-frn-ok" data-bp-frn-close>Ok</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  const close = (): void => {
    wrap.remove();
    void clearPendingRemovals(uid);
  };
  wrap.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    // Let profile links navigate; close on backdrop / ✕ / Ok.
    if (target?.closest('.bp-frn-name')) {
      void clearPendingRemovals(uid);
      return;
    }
    if (target?.closest('[data-bp-frn-close]')) {
      event.preventDefault();
      close();
    }
  });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onKey, true);
    }
  };
  document.addEventListener('keydown', onKey, true);
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .bp-frn-wrap {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      box-sizing: border-box;
      font-family: Arial, Helvetica, sans-serif;
    }
    .bp-frn-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0,0,0,0.55);
    }
    .bp-frn-modal {
      position: relative;
      width: min(520px, calc(100vw - 36px));
      background: #1f2125;
      color: #f2f3f5;
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 8px;
      box-shadow: 0 22px 60px rgba(0,0,0,0.55);
      overflow: hidden;
    }
    .bp-frn-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .bp-frn-title {
      font-size: 16px;
      font-weight: 800;
      letter-spacing: 0.01em;
    }
    .bp-frn-x {
      flex: 0 0 auto;
      width: 30px;
      height: 30px;
      border: 0;
      border-radius: 6px;
      background: #e1322d;
      color: #fff;
      font-size: 22px;
      line-height: 1;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .bp-frn-x:hover { background: #f0413c; }
    .bp-frn-body {
      padding: 18px 16px;
      font-size: 14px;
      line-height: 1.5;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .bp-frn-names { font-weight: 800; }
    .bp-frn-name {
      color: #7aa6ff;
      font-weight: 800;
      text-decoration: none;
    }
    .bp-frn-name:hover { text-decoration: underline; }
    .bp-frn-sep { color: rgba(255,255,255,0.55); font-weight: 400; }
    .bp-frn-actions {
      display: flex;
      justify-content: center;
      padding: 14px 16px;
    }
    .bp-frn-ok {
      min-width: 120px;
      height: 34px;
      padding: 0 18px;
      border: 0;
      border-radius: 6px;
      background: rgba(255,255,255,0.10);
      color: #f2f3f5;
      font-size: 13px;
      font-weight: 800;
      cursor: pointer;
    }
    .bp-frn-ok:hover { background: rgba(255,255,255,0.16); }
  `;
  document.head.appendChild(style);
}
