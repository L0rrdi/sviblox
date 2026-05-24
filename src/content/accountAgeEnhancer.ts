/**
 * On `/users/<id>/profile`, append a non-interactive "X years, Y months"
 * pill to the Friends / Followers / Following row in the profile header.
 *
 * The pill mimics the enabled-style anchor classes Roblox uses for the
 * other three pills so it visually slots in, but has no href and the
 * click handler just preventDefaults — purely informational. Gated by
 * the `showAccountAge` popup toggle.
 */

import { getRobloxUser } from '@/api/users';
import { getSettings } from '@/storage/settingsStore';

const PILL_ID = 'bloxplus-account-age-pill';
// Classes copied verbatim from one of Roblox's enabled Friends/Followers/
// Following anchors so the pill picks up identical sizing, padding, hover,
// and theming. If Roblox restyles the row, update here.
const PILL_ANCHOR_CLASS =
  'relative clip group/interactable focus-visible:outline-focus disabled:outline-none cursor-pointer relative flex justify-center items-center radius-circle stroke-none padding-left-medium padding-right-medium height-800 text-label-medium bg-shift-300 content-action-utility';
const PILL_OVERLAY_CLASS =
  'absolute inset-[0] transition-colors group-hover/interactable:bg-[var(--color-state-hover)] group-active/interactable:bg-[var(--color-state-press)] group-disabled/interactable:bg-none';
const PILL_LABEL_CLASS = 'padding-y-xsmall text-no-wrap text-truncate-end';

let inflight = false;

export async function run(): Promise<void> {
  const userId = readProfileUserId();
  if (!userId) {
    cleanup();
    return;
  }

  const settings = await getSettings();
  if (!settings.showAccountAge) {
    cleanup();
    return;
  }

  const existing = document.getElementById(PILL_ID);
  if (existing && existing.dataset.bpUserId === String(userId)) {
    // Re-anchor if React swapped the row but left our pill orphaned.
    if (!existing.isConnected || !existing.parentElement?.matches('.flex-nowrap.gap-small.flex')) {
      existing.remove();
    } else {
      return;
    }
  } else if (existing) {
    existing.remove();
  }

  if (inflight) return;
  inflight = true;
  try {
    const user = await getRobloxUser(userId);
    if (!user?.created) return;
    const label = formatAge(user.created);
    if (!label) return;
    render(userId, label);
  } finally {
    inflight = false;
  }
}

function cleanup(): void {
  document.getElementById(PILL_ID)?.remove();
}

function render(userId: number, label: string): void {
  const row = findStatsRow();
  if (!row) return;
  if (document.getElementById(PILL_ID)) return;

  // Span, not anchor — this pill is display-only and screen readers
  // shouldn't announce it as a link.
  const pill = document.createElement('span');
  pill.id = PILL_ID;
  pill.dataset.bpUserId = String(userId);
  pill.className = PILL_ANCHOR_CLASS;
  pill.style.cursor = 'default';
  pill.title = label;

  const overlay = document.createElement('div');
  overlay.setAttribute('role', 'presentation');
  overlay.className = PILL_OVERLAY_CLASS;

  const text = document.createElement('span');
  text.className = PILL_LABEL_CLASS;
  text.textContent = label;

  pill.append(overlay, text);
  row.appendChild(pill);
}

function findStatsRow(): HTMLElement | null {
  // Anchor off the Following link — its href shape is stable across users.
  const following = document.querySelector<HTMLAnchorElement>(
    '.user-profile-header a[href*="/friends#!/following"]'
  );
  const row = following?.parentElement;
  if (row && row.matches('.flex-nowrap.gap-small.flex')) return row;
  // Fallback: any row inside the header matching the layout class triple.
  return document.querySelector<HTMLElement>(
    '.user-profile-header .flex-nowrap.gap-small.flex'
  );
}

function formatAge(createdIso: string): string | null {
  const then = new Date(createdIso);
  if (Number.isNaN(then.getTime())) return null;
  const now = new Date();
  let years = now.getFullYear() - then.getFullYear();
  let months = now.getMonth() - then.getMonth();
  if (now.getDate() < then.getDate()) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  if (years < 0) return null;
  if (years === 0 && months === 0) return 'New';
  const parts: string[] = [];
  if (years > 0) parts.push(`${years} ${years === 1 ? 'year' : 'years'}`);
  if (months > 0) parts.push(`${months} ${months === 1 ? 'month' : 'months'}`);
  return parts.join(', ');
}

function readProfileUserId(): number | null {
  const m = location.pathname.match(/^\/users\/(\d+)\/profile/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
