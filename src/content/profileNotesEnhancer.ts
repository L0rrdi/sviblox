/**
 * Private profile notes + nicknames. On `/users/<id>/profile` (other people,
 * never your own), injects:
 *
 *  1. A small `(nickname)` chip next to the user's `@username` line, mirroring
 *     the friend-last-online chip's anchor so we get sensible placement.
 *  2. A SviBlox card under the profile header with editable Nickname / Note
 *     inputs. Auto-saves to `chrome.storage.local` via `profileAnnotations`.
 *
 * The whole feature is gated by the `showProfileNotes` popup toggle.
 *
 * Nicknames are *cosmetic* — they NEVER replace the user's real
 * displayName / username anywhere. Just appended.
 */

import { getAuthenticatedUserId } from '@/api/users';
import { getSettings } from '@/storage/settingsStore';
import { escapeHtml, escapeAttr } from '@/util/html';
import {
  ensureAnnotationsPrimed,
  getAnnotation,
  onAnnotationsChanged,
  setAnnotation,
  PROFILE_ANNOTATION_LIMITS,
} from '@/storage/profileAnnotations';

const CARD_ID = 'bloxplus-profile-notes-card';
const CHIP_ID = 'bloxplus-profile-nickname-chip';
const STYLE_ID = 'bloxplus-profile-notes-style';

const USERNAME_ANCHOR_SEL = '.stylistic-alts-username';
const CARD_ANCHOR_SELS = [
  '.profile-header',
  '[class*="profile-header"]',
  '#profile-about',
  '.profile-about',
  '#content',
] as const;

let mountedForUser: number | null = null;
let mountedForPath: string | null = null;
let inflight = false;
let subscribed = false;

export async function run(): Promise<void> {
  const userId = readProfileUserId();
  if (!userId) {
    cleanup();
    return;
  }

  const settings = await getSettings();
  if (!settings.showProfileNotes) {
    cleanup();
    return;
  }

  if (mountedForUser === userId && mountedForPath === location.pathname) {
    // Re-attach if Roblox React re-rendered the header.
    reattachIfMissing(userId);
    return;
  }
  if (inflight) return;
  inflight = true;

  try {
    cleanup();
    const me = await getAuthenticatedUserId();
    if (me && me === userId) return; // Skip own profile entirely.

    await ensureAnnotationsPrimed();
    ensureStyle();
    if (!subscribed) {
      subscribed = true;
      onAnnotationsChanged(() => {
        // Re-render the chip from cache; the card's inputs are user-driven
        // so we don't touch them here (avoids fighting the user's typing).
        if (mountedForUser !== null) renderNicknameChip(mountedForUser);
      });
    }
    renderCard(userId);
    renderNicknameChip(userId);
    mountedForUser = userId;
    mountedForPath = location.pathname;
  } finally {
    inflight = false;
  }
}

function cleanup(): void {
  document.getElementById(CARD_ID)?.remove();
  document.getElementById(CHIP_ID)?.remove();
  mountedForUser = null;
  mountedForPath = null;
}

function reattachIfMissing(userId: number): void {
  if (!document.getElementById(CARD_ID)) renderCard(userId);
  if (!document.getElementById(CHIP_ID)) renderNicknameChip(userId);
}

function readProfileUserId(): number | null {
  const m = location.pathname.match(/^\/users\/(\d+)\/profile/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function findCardAnchor(): HTMLElement | null {
  for (const sel of CARD_ANCHOR_SELS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

function renderNicknameChip(userId: number): void {
  const existing = document.getElementById(CHIP_ID);
  const ann = getAnnotation(userId);
  const nickname = ann?.nickname?.trim();
  if (!nickname) {
    existing?.remove();
    return;
  }
  const anchor = document.querySelector<HTMLElement>(USERNAME_ANCHOR_SEL);
  if (!anchor) return;
  const chip = existing ?? document.createElement('span');
  chip.id = CHIP_ID;
  chip.className = 'bp-nickname-chip';
  chip.textContent = `(${nickname})`;
  chip.title = 'Your private nickname for this user (visible only to you)';
  if (chip.parentElement !== anchor.parentElement) {
    anchor.insertAdjacentElement('afterend', chip);
  }
}

function renderCard(userId: number): void {
  const anchor = findCardAnchor();
  if (!anchor) return;
  const ann = getAnnotation(userId);
  const nickname = ann?.nickname ?? '';
  const note = ann?.note ?? '';

  let card = document.getElementById(CARD_ID);
  if (!card) {
    card = document.createElement('section');
    card.id = CARD_ID;
    card.className = 'bp-profile-notes-card';
    anchor.insertAdjacentElement('afterend', card);
  } else if (card.previousElementSibling !== anchor) {
    anchor.insertAdjacentElement('afterend', card);
  }

  card.innerHTML = `
    <header class="bp-profile-notes-header">
      <span class="bp-profile-notes-title">📝 Your notes</span>
      <span class="bp-profile-notes-status" data-status></span>
    </header>
    <div class="bp-profile-notes-grid">
      <label class="bp-profile-notes-field">
        <span>Nickname</span>
        <input
          type="text"
          data-bp-nickname
          maxlength="${PROFILE_ANNOTATION_LIMITS.nicknameMax}"
          placeholder="A private label only you see"
          value="${escapeAttr(nickname)}"
        />
      </label>
      <label class="bp-profile-notes-field bp-profile-notes-field-wide">
        <span>Note</span>
        <textarea
          data-bp-note
          maxlength="${PROFILE_ANNOTATION_LIMITS.noteMax}"
          rows="3"
          placeholder="Free-form text. Stays on this device."
        >${escapeHtml(note)}</textarea>
      </label>
    </div>
    <footer class="bp-profile-notes-footer">
      <span class="bp-profile-notes-hint">Stored locally · never sent anywhere</span>
      <span class="bp-profile-notes-updated" data-updated>${ann?.updatedAt ? `Saved ${formatRelative(ann.updatedAt)}` : ''}</span>
    </footer>
  `;

  attachAutoSave(card, userId);
}

function attachAutoSave(card: HTMLElement, userId: number): void {
  const nicknameEl = card.querySelector<HTMLInputElement>('[data-bp-nickname]');
  const noteEl = card.querySelector<HTMLTextAreaElement>('[data-bp-note]');
  if (!nicknameEl || !noteEl) return;

  const status = card.querySelector<HTMLElement>('[data-status]');
  const updated = card.querySelector<HTMLElement>('[data-updated]');

  // Per-card timer (closure-local). Was previously module-level, which let a
  // second card's scheduleSave clearTimeout the first card's pending save —
  // navigating between profiles mid-typing silently lost your unsaved changes.
  // With closure scope, each card owns its own pending save; the captured
  // userId + input elements (even when detached) keep saving correctly.
  let saveTimer: number | undefined;

  const scheduleSave = (immediate = false): void => {
    if (saveTimer !== undefined) {
      window.clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    const fire = async () => {
      if (status?.isConnected) status.textContent = 'Saving...';
      const next = await setAnnotation(userId, {
        nickname: nicknameEl.value,
        note: noteEl.value,
      });
      if (status?.isConnected) status.textContent = 'Saved';
      if (updated?.isConnected) {
        updated.textContent = next?.updatedAt ? `Saved ${formatRelative(next.updatedAt)}` : '';
      }
      window.setTimeout(() => {
        if (status?.isConnected && status.textContent === 'Saved') status.textContent = '';
      }, 1200);
    };
    if (immediate) void fire();
    else saveTimer = window.setTimeout(fire, 750);
  };

  nicknameEl.addEventListener('input', () => scheduleSave());
  noteEl.addEventListener('input', () => scheduleSave());
  nicknameEl.addEventListener('blur', () => scheduleSave(true));
  noteEl.addEventListener('blur', () => scheduleSave(true));
}

function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const diff = Math.max(0, Date.now() - then) / 1000;
  if (diff < 5) return 'just now';
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(then).toLocaleDateString();
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .bp-nickname-chip {
      display: inline-flex; align-items: center;
      margin-left: 8px;
      padding: 1px 8px;
      border-radius: 999px;
      background: rgba(116, 64, 234, 0.18);
      border: 1px solid rgba(116, 64, 234, 0.55);
      color: #c5b3ff;
      font: 600 11px/1.4 inherit;
      vertical-align: baseline;
      white-space: nowrap;
    }
    .bp-profile-notes-card {
      margin: 14px 0;
      padding: 14px 16px;
      border-radius: 8px;
      background: rgba(24, 28, 34, 0.95);
      border: 1px solid rgba(255,255,255,0.10);
      color: rgba(255,255,255,0.92);
      box-shadow: 0 6px 18px rgba(0,0,0,0.18);
    }
    .bp-profile-notes-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 12px;
    }
    .bp-profile-notes-title {
      font-size: 14px; font-weight: 700;
    }
    .bp-profile-notes-status {
      font-size: 11px; color: rgba(255,255,255,0.6);
    }
    .bp-profile-notes-grid {
      display: grid; gap: 10px;
      grid-template-columns: minmax(160px, 240px) 1fr;
    }
    .bp-profile-notes-field {
      display: flex; flex-direction: column; gap: 4px;
      min-width: 0;
    }
    .bp-profile-notes-field span {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      color: rgba(255,255,255,0.55);
    }
    .bp-profile-notes-field input,
    .bp-profile-notes-field textarea {
      width: 100%; box-sizing: border-box;
      padding: 7px 10px;
      font: 13px/1.4 inherit;
      color: #fff;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 6px;
      resize: vertical;
    }
    .bp-profile-notes-field input:focus,
    .bp-profile-notes-field textarea:focus {
      outline: none;
      border-color: rgba(116, 64, 234, 0.75);
      background: rgba(255,255,255,0.08);
    }
    .bp-profile-notes-footer {
      display: flex; justify-content: space-between;
      margin-top: 10px;
      font-size: 11px; color: rgba(255,255,255,0.55);
    }
    @media (max-width: 720px) {
      .bp-profile-notes-grid { grid-template-columns: 1fr; }
    }
    body:not(.dark-theme) .bp-profile-notes-card {
      background: #fff;
      border-color: rgba(0,0,0,0.10);
      color: #272930;
      box-shadow: 0 4px 14px rgba(0,0,0,0.08);
    }
    body:not(.dark-theme) .bp-profile-notes-field span,
    body:not(.dark-theme) .bp-profile-notes-status,
    body:not(.dark-theme) .bp-profile-notes-footer {
      color: rgba(39,41,48,0.62);
    }
    body:not(.dark-theme) .bp-profile-notes-field input,
    body:not(.dark-theme) .bp-profile-notes-field textarea {
      background: rgba(0,0,0,0.04);
      color: #191b22;
      border-color: rgba(0,0,0,0.10);
    }
  `;
  document.head.appendChild(style);
}
