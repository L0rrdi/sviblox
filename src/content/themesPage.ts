/**
 * Renders the SviBlox Themes page as an overlay inside the Roblox home
 * content area, triggered by `location.hash === '#bloxplus-themes'`.
 * Roblox's left nav, header, and chat remain functional; only the home
 * main content gets replaced.
 *
 * Save model: edits to the active theme (colors, image, brightness, mode)
 * are buffered in a draft and previewed live. Clicking Apply opens a small
 * modal — Overwrite / New / Cancel when the active theme is a user-saved
 * preset, or just New / Cancel when it's a built-in preset. "New" prompts
 * for a name (prefilled with the next "Custom #N") and creates a new user
 * preset which becomes active.
 */

import { getSettings, onSettingsChanged, setSettings } from '@/storage/settingsStore';
import {
  getCustomTheme,
  getUserThemes,
  createUserTheme,
  deleteUserTheme,
  renameUserTheme,
  overwriteUserTheme,
  suggestNextUserTheme,
  setCustomThemeBackground,
  setCustomThemeVideo,
  removeCustomThemeBackground,
  onUserThemesChanged,
} from '@/storage/themeStore';
import { putVideo, getVideo, deleteVideo } from '@/storage/videoStore';
import {
  getPresets,
  setPreviewTheme,
  setBackgroundBrightnessPreview,
  setBackgroundVolumePreview,
  setBackgroundImagePreview,
} from './themeInjector';
import {
  getThemeScheduleChoices,
  resolveThemeSchedule,
  sanitizeThemeSchedule,
} from '@/storage/themeSchedule';
import { CustomTheme, ThemeSchedule, UserThemeEntry } from '@/types';
import { escapeHtml } from '@/util/html';

const PAGE_ID = 'bloxplus-themes-page';
const STYLE_ID = 'bloxplus-themes-page-style';
const MODAL_ID = 'bloxplus-themes-modal';
const HIDE_ATTR = 'data-bp-themes-hidden';
const HIDE_PRIOR_DISPLAY_ATTR = 'data-bp-themes-prior-display';
// Cap at 4 MB raw — data-URL encoding inflates by ~33% so the persisted size
// is ~5.3 MB per preset. Previously 16 MB, which produced ~21 MB blobs per
// preset and ate local storage fast once multi-preset themes shipped.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
// Videos are stored as raw blobs in IndexedDB (not base64 in chrome.storage),
// so they can be much larger than stills. Cap to keep page-load + GPU sane.
const MAX_VIDEO_BYTES = 128 * 1024 * 1024;
const VIDEO_MIME_RE = /^video\/(mp4|webm|ogg)$/i;

function isThemesRoute(): boolean {
  return location.hash.replace(/^#/, '') === 'bloxplus-themes';
}

/**
 * Home is the only path where the overlay should mount. Without this guard,
 * landing on /games/123#bloxplus-themes would replace the game page's main
 * content with the Themes overlay (the host-finder falls back to `main` if
 * #HomeContainer isn't present).
 */
function isHomePath(): boolean {
  return location.pathname === '/' || location.pathname.startsWith('/home');
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${PAGE_ID} { padding: 24px 0; color: inherit; font-family: inherit; }
    #${PAGE_ID} h1 { font-size: 28px; margin: 0 0 8px 0; font-weight: 700; }
    #${PAGE_ID} p.bp-tp-sub { margin: 0 0 24px 0; opacity: 0.7; font-size: 14px; }

    #${PAGE_ID} .bp-tp-section {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 20px;
    }
    #${PAGE_ID} .bp-tp-section h2 { font-size: 18px; margin: 0 0 14px 0; font-weight: 600; }

    #${PAGE_ID} .bp-presets {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 12px;
    }
    #${PAGE_ID} .bp-preset {
      position: relative;
      border: 2px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      padding: 12px;
      cursor: pointer;
      background: rgba(255,255,255,0.03);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    #${PAGE_ID} .bp-preset.bp-active { border-color: #4a90e2; }
    #${PAGE_ID} .bp-preset:hover { background: rgba(255,255,255,0.08); }
    #${PAGE_ID} .bp-preset-swatch {
      height: 48px; border-radius: 6px;
      background: linear-gradient(135deg, var(--s-bg, #15171c) 50%, var(--s-card, #2a2d35) 50%);
      border: 1px solid rgba(255,255,255,0.1);
    }
    /* When a user preset has a background image, show that as the swatch
       instead of the palette gradient. The image is set via JS (data URLs
       don't survive inline style attributes). */
    #${PAGE_ID} .bp-preset-swatch[data-has-image] {
      background-color: #000;
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
    }
    #${PAGE_ID} .bp-preset-name { font-weight: 600; font-size: 14px; }
    #${PAGE_ID} .bp-preset-id { font-size: 11px; opacity: 0.55; }
    #${PAGE_ID} .bp-preset-add {
      border-style: dashed;
      border-color: rgba(255,255,255,0.25);
      align-items: center; justify-content: center;
      text-align: center; min-height: 116px;
      color: rgba(255,255,255,0.75);
    }
    #${PAGE_ID} .bp-preset-add:hover { border-color: #4a90e2; color: #fff; }
    #${PAGE_ID} .bp-preset-add .bp-preset-add-icon {
      font-size: 26px; line-height: 1; font-weight: 300; margin-bottom: 4px;
    }
    #${PAGE_ID} .bp-preset-tools {
      position: absolute; top: 6px; right: 6px;
      display: none; gap: 4px;
    }
    #${PAGE_ID} .bp-preset:hover .bp-preset-tools { display: inline-flex; }
    #${PAGE_ID} .bp-preset-tools button {
      padding: 2px 6px; font-size: 11px;
      background: rgba(0,0,0,0.55); color: #fff;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 4px; cursor: pointer;
    }
    #${PAGE_ID} .bp-preset-tools button:hover { background: rgba(74,144,226,0.8); }
    #${PAGE_ID} .bp-preset-tools button.bp-danger:hover { background: rgba(217,83,79,0.85); }

    #${PAGE_ID} .bp-color-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 14px;
    }
    #${PAGE_ID} .bp-color-row { display: flex; align-items: center; gap: 10px; }
    #${PAGE_ID} .bp-color-row label { flex: 1; font-size: 13px; }
    #${PAGE_ID} .bp-color-row input[type="color"] {
      width: 44px; height: 32px; border: 1px solid rgba(255,255,255,0.18);
      border-radius: 4px; padding: 0; background: transparent; cursor: pointer;
    }
    #${PAGE_ID} .bp-color-row input[type="text"] {
      width: 100px; padding: 4px 6px; font-family: monospace; font-size: 12px;
      background: #1a1d24; color: inherit;
      border: 1px solid rgba(255,255,255,0.18); border-radius: 4px;
    }

    #${PAGE_ID} .bp-bg-controls { display: flex; flex-direction: column; gap: 12px; }
    #${PAGE_ID} .bp-bg-preview {
      position: relative; overflow: hidden;
      width: 100%; height: 160px; max-height: 220px; min-height: 120px;
      background: #15171c center/cover no-repeat;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 6px;
      display: flex; align-items: center; justify-content: center;
      font-size: 12px; opacity: 0.7;
    }
    #${PAGE_ID} .bp-bg-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }

    #${PAGE_ID} .bp-schedule-grid {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    #${PAGE_ID} .bp-schedule-slot {
      display: grid;
      grid-template-columns: minmax(110px, 1fr) minmax(150px, 1.4fr) 108px auto;
      gap: 8px;
      align-items: end;
    }
    @media (max-width: 720px) {
      #${PAGE_ID} .bp-schedule-slot {
        grid-template-columns: 1fr;
      }
      #${PAGE_ID} .bp-schedule-remove {
        width: 100%;
      }
    }
    #${PAGE_ID} .bp-schedule-field {
      display: flex; flex-direction: column; gap: 6px;
      font-size: 13px;
    }
    #${PAGE_ID} .bp-schedule-field select,
    #${PAGE_ID} .bp-schedule-field input[type="text"],
    #${PAGE_ID} .bp-schedule-field input[type="time"] {
      padding: 7px 8px;
      background: #1a1d24; color: inherit;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 4px;
      color-scheme: dark;
    }
    #${PAGE_ID} .bp-schedule-toggle {
      display: inline-flex; gap: 8px; align-items: center;
      font-size: 13px; margin-bottom: 14px;
    }
    #${PAGE_ID} .bp-schedule-remove {
      min-width: 34px;
      padding-inline: 0;
    }
    #${PAGE_ID} .bp-schedule-note {
      font-size: 12px; opacity: 0.7; margin-top: 10px; min-height: 16px;
    }

    #${PAGE_ID} .bp-actions {
      display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px;
    }
    #${PAGE_ID} button.bp-btn {
      padding: 8px 14px; font-size: 13px; font-weight: 500;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.18);
      background: rgba(255,255,255,0.06);
      color: inherit; cursor: pointer;
    }
    #${PAGE_ID} button.bp-btn:hover { background: rgba(255,255,255,0.12); }
    #${PAGE_ID} button.bp-btn.bp-btn-primary {
      background: #4a90e2; border-color: #4a90e2; color: #fff;
    }
    #${PAGE_ID} button.bp-btn.bp-btn-danger {
      background: rgba(217, 83, 79, 0.2); border-color: #d9534f; color: #f8a8a5;
    }
    #${PAGE_ID} .bp-mode-row select {
      padding: 4px 24px 4px 8px;
      background: #1a1d24; color: inherit;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 4px; cursor: pointer;
    }
    #${PAGE_ID} .bp-brightness-label { display: flex; align-items: center; gap: 10px; font-size: 13px; }
    #${PAGE_ID} .bp-brightness-label input[type="range"] { flex: 1; max-width: 320px; accent-color: #4a90e2; }
    #${PAGE_ID} .bp-num-input {
      display: inline-flex; align-items: center; gap: 2px;
      font-size: 12px; opacity: 0.8; flex: 0 0 auto;
    }
    #${PAGE_ID} .bp-num-input input[type="number"] {
      width: 50px; text-align: right; font-variant-numeric: tabular-nums;
      background: #1a1d24; color: #e6e6e6;
      border: 1px solid rgba(255,255,255,0.18); border-radius: 4px;
      padding: 3px 6px; font-size: 12px; outline: none;
    }
    #${PAGE_ID} .bp-num-input input[type="number"]:hover { border-color: rgba(255,255,255,0.32); }
    #${PAGE_ID} .bp-num-input input[type="number"]:focus {
      border-color: rgba(74,144,226,0.9); box-shadow: 0 0 0 2px rgba(74,144,226,0.18);
    }
    #${PAGE_ID} .bp-status { font-size: 12px; opacity: 0.7; margin-top: 8px; min-height: 14px; }

    /* Sticky Apply/Cancel bar that appears while editing. */
    #${PAGE_ID} .bp-draft-bar {
      position: sticky; bottom: 12px;
      display: flex; gap: 10px; align-items: center;
      margin-top: 16px; padding: 12px 14px;
      border-radius: 8px;
      background: rgba(20,22,28,0.92);
      backdrop-filter: blur(6px);
      border: 1px solid rgba(255,255,255,0.12);
      opacity: 0; pointer-events: none;
      transition: opacity 0.15s ease;
      z-index: 2;
    }
    #${PAGE_ID} .bp-draft-bar.bp-dirty { opacity: 1; pointer-events: auto; }
    #${PAGE_ID} .bp-draft-bar .bp-dirty-label {
      font-size: 12px; opacity: 0.75; margin-left: auto;
    }

    /* Modal */
    #${MODAL_ID} {
      position: fixed; inset: 0; z-index: 9999;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,0.55);
    }
    #${MODAL_ID} .bp-modal-box {
      min-width: 320px; max-width: 480px;
      background: #1c1f26; color: #fff;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 10px;
      padding: 22px 24px;
      box-shadow: 0 24px 48px rgba(0,0,0,0.5);
      font-family: inherit;
    }
    #${MODAL_ID} h3 { margin: 0 0 10px 0; font-size: 17px; font-weight: 600; }
    #${MODAL_ID} p { margin: 0 0 16px 0; font-size: 13px; opacity: 0.85; line-height: 1.5; }
    #${MODAL_ID} input[type="text"] {
      width: 100%; padding: 8px 10px; margin-bottom: 16px;
      background: #14171d; color: inherit;
      border: 1px solid rgba(255,255,255,0.18); border-radius: 4px;
      font: inherit; font-size: 14px;
    }
    #${MODAL_ID} input[type="text"]:focus { outline: 2px solid #4a90e2; outline-offset: -1px; }
    #${MODAL_ID} .bp-modal-actions {
      display: flex; gap: 8px; justify-content: flex-end;
    }
    #${MODAL_ID} .bp-modal-actions button {
      padding: 7px 14px; font-size: 13px; font-weight: 500;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.18);
      background: rgba(255,255,255,0.06);
      color: inherit; cursor: pointer;
    }
    #${MODAL_ID} .bp-modal-actions button:hover { background: rgba(255,255,255,0.12); }
    #${MODAL_ID} .bp-modal-actions button.bp-primary {
      background: #4a90e2; border-color: #4a90e2; color: #fff;
    }
  `;
  document.head.appendChild(style);
}

function findHomeContentHost(): HTMLElement | null {
  const root = document.getElementById('HomeContainer');
  if (root instanceof HTMLElement) return root;
  const main = document.querySelector('main, #content, .content');
  return main instanceof HTMLElement ? main : null;
}

const SIBLING_OVERLAY_IDS = ['bloxplus-uhbl-page', 'bloxplus-badgerhub-page'];
const OVERLAY_HASHES = ['bloxplus-themes', 'bloxplus-uhbl', 'bloxplus-badgerhub'];

function hideHomeContent(host: HTMLElement): void {
  for (const child of host.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.id === PAGE_ID) continue;
    if (SIBLING_OVERLAY_IDS.includes(child.id)) continue;
    if (!child.hasAttribute(HIDE_ATTR)) {
      // Stash the original inline `display` so restoreHomeContent can put
      // it back exactly. Most Roblox children have no inline display, so
      // the stash is usually an empty string — fine.
      child.setAttribute(HIDE_PRIOR_DISPLAY_ATTR, child.style.display);
      child.style.display = 'none';
      child.setAttribute(HIDE_ATTR, '1');
    }
  }
}

function restoreHomeContent(): void {
  const handoff =
    OVERLAY_HASHES.includes(location.hash.replace(/^#/, '')) && !isThemesRoute();
  for (const el of document.querySelectorAll(`[${HIDE_ATTR}]`)) {
    if (!(el instanceof HTMLElement)) continue;
    if (!handoff) {
      el.style.display = el.getAttribute(HIDE_PRIOR_DISPLAY_ATTR) ?? '';
      el.removeAttribute(HIDE_PRIOR_DISPLAY_ATTR);
    }
    el.removeAttribute(HIDE_ATTR);
  }
}

async function mountPage(host: HTMLElement): Promise<void> {
  let page = document.getElementById(PAGE_ID);
  if (page) {
    if (page.parentElement !== host) host.appendChild(page);
    return;
  }
  page = document.createElement('div');
  page.id = PAGE_ID;
  host.appendChild(page);
  await render(page);
}

// ── Modal helpers ─────────────────────────────────────────────────────────

function openNameModal(opts: { title: string; defaultValue: string; confirmLabel: string }): Promise<string | null> {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.id = MODAL_ID;
    root.innerHTML = `
      <div class="bp-modal-box" role="dialog" aria-modal="true">
        <h3>${escapeHtml(opts.title)}</h3>
        <input type="text" data-name-input value="${escapeHtml(opts.defaultValue)}" />
        <div class="bp-modal-actions">
          <button data-act="cancel">Cancel</button>
          <button class="bp-primary" data-act="confirm">${escapeHtml(opts.confirmLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    const input = root.querySelector<HTMLInputElement>('[data-name-input]')!;
    input.focus();
    input.select();
    const cleanup = (value: string | null) => {
      root.remove();
      resolve(value);
    };
    root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === root) return cleanup(null);
      const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'confirm') return cleanup(input.value.trim() || opts.defaultValue);
      if (act === 'cancel') return cleanup(null);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') cleanup(input.value.trim() || opts.defaultValue);
      else if (e.key === 'Escape') cleanup(null);
    });
  });
}

function openConfirmModal(opts: { title: string; body: string; confirmLabel: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.id = MODAL_ID;
    root.innerHTML = `
      <div class="bp-modal-box" role="dialog" aria-modal="true">
        <h3>${escapeHtml(opts.title)}</h3>
        <p>${escapeHtml(opts.body)}</p>
        <div class="bp-modal-actions">
          <button data-act="cancel">Cancel</button>
          <button class="bp-primary" data-act="confirm">${escapeHtml(opts.confirmLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    const cleanup = (v: boolean) => { root.remove(); resolve(v); };
    root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === root) return cleanup(false);
      const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'confirm') return cleanup(true);
      if (act === 'cancel') return cleanup(false);
    });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKey);
        cleanup(false);
      }
    });
  });
}

// ── Render ────────────────────────────────────────────────────────────────

async function render(page: HTMLElement): Promise<void> {
  const settings = await getSettings();
  const custom = await getCustomTheme();
  const userThemes = await getUserThemes();
  const presets = getPresets();
  const activeId = settings.themeId;
  const activeEntry: UserThemeEntry | null = userThemes.entries[activeId] ?? null;
  const schedule = sanitizeThemeSchedule(settings.themeSchedule, userThemes);
  const scheduleResolution = resolveThemeSchedule({ ...settings, themeSchedule: schedule }, userThemes);
  const scheduleChoices = getThemeScheduleChoices(userThemes);
  const activeScheduleSlotId = scheduleResolution?.slotId ?? schedule.slots[0]?.id;
  const activationPatch = (themeId: string) => ({
    themeId,
    ...(schedule.enabled
      ? {
          themeSchedule: {
            ...schedule,
            slots: schedule.slots.map((slot) =>
              slot.id === activeScheduleSlotId ? { ...slot, themeId } : slot
            ),
          },
        }
      : {}),
  });

  const setStatus = (msg: string) => {
    const el = page.querySelector('.bp-status');
    if (el) el.textContent = msg;
  };

  const scheduleOption = (selectedId: string): string =>
    scheduleChoices
      .map((choice) => {
        const label = `${choice.name}${choice.kind === 'custom' ? ' (custom)' : ''}`;
        return `<option value="${escapeHtml(choice.id)}" ${choice.id === selectedId ? 'selected' : ''}>${escapeHtml(label)}</option>`;
      })
      .join('');

  const scheduleRows = schedule.slots
    .map(
      (slot, index) => `
        <div class="bp-schedule-slot" data-schedule-slot="${escapeHtml(slot.id)}">
          <label class="bp-schedule-field">Name
            <input type="text" value="${escapeHtml(slot.label)}" maxlength="32" data-schedule-label />
          </label>
          <label class="bp-schedule-field">Preset
            <select data-schedule-theme>
              ${scheduleOption(slot.themeId)}
            </select>
          </label>
          <label class="bp-schedule-field">Starts
            <input type="time" value="${escapeHtml(slot.startsAt)}" data-schedule-time />
          </label>
          <button class="bp-btn bp-schedule-remove" type="button" title="Remove slot"
                  data-schedule-remove="${escapeHtml(slot.id)}" ${schedule.slots.length <= 2 ? 'disabled' : ''}>
            ${index + 1 > 2 ? '-' : 'x'}
          </button>
        </div>
      `
    )
    .join('');

  const scheduleNote =
    schedule.enabled && scheduleResolution
      ? `Currently using ${scheduleChoices.find((choice) => choice.id === scheduleResolution.themeId)?.name ?? scheduleResolution.themeId} (${scheduleResolution.slotLabel}) until ${scheduleResolution.nextStartsAt}.`
      : 'Schedule is off. Your selected preset stays active until you change it.';

  const colorRow = (
    key: keyof CustomTheme,
    label: string,
    fallback: string,
    mirror?: keyof CustomTheme
  ): string => {
    const v = (custom[key] as string | undefined) ?? '';
    const mirrorAttr = mirror ? ` data-mirror-to="${mirror}"` : '';
    return `
      <div class="bp-color-row" data-key="${key}"${mirrorAttr}>
        <label>${label}</label>
        <input type="color" value="${normalizeColor(v) || fallback}" data-color-input />
        <input type="text" value="${v}" placeholder="${fallback}" data-color-text />
      </div>
    `;
  };

  const builtInTiles = presets
    .map(
      (p) => `
      <div class="bp-preset ${p.id === activeId ? 'bp-active' : ''}" data-preset="${p.id}"
           style="--s-bg:${p.vars?.background ?? '#15171c'}; --s-card:${p.vars?.nav ?? '#2a2d35'};">
        <div class="bp-preset-swatch"></div>
        <div class="bp-preset-name">${escapeHtml(p.name)}</div>
        <div class="bp-preset-id">built-in</div>
      </div>
    `
    )
    .join('');

  const userTiles = userThemes.order
    .map((id) => userThemes.entries[id])
    .filter((e): e is UserThemeEntry => !!e)
    .map(
      (e) => `
      <div class="bp-preset ${e.id === activeId ? 'bp-active' : ''}" data-preset="${e.id}" data-user-preset="${e.id}"
           style="--s-bg:${e.theme.background ?? '#222'}; --s-card:${e.theme.nav ?? '#444'};">
        <div class="bp-preset-tools">
          <button data-tool="rename" data-id="${e.id}">Rename</button>
          <button class="bp-danger" data-tool="delete" data-id="${e.id}">Delete</button>
        </div>
        <div class="bp-preset-swatch"></div>
        <div class="bp-preset-name">${escapeHtml(e.name)}</div>
        <div class="bp-preset-id">${e.id}</div>
      </div>
    `
    )
    .join('');

  page.innerHTML = `
    <h1>Themes</h1>
    <p class="bp-tp-sub">Customise SviBlox's look across roblox.com. Select a built-in preset, mix your own palette, or upload an image to use as a background.</p>

    <div class="bp-tp-section">
      <h2>Presets</h2>
      <div class="bp-presets">${builtInTiles}${userTiles}
        <div class="bp-preset bp-preset-add" data-action="new-preset" role="button" tabindex="0" title="Create an empty preset">
          <div class="bp-preset-add-icon">+</div>
          <div class="bp-preset-name">New preset</div>
        </div>
      </div>
    </div>

    <div class="bp-tp-section">
      <h2>Palette</h2>
      <p class="bp-tp-sub" style="margin: 0 0 14px 0;">Changes preview live. Apply saves them to a preset.</p>
      <div class="bp-color-grid">
        ${colorRow('background', 'Page background', '#0e0f12')}
        ${colorRow('nav', 'Navigation', '#0a0b0e')}
        ${colorRow('text', 'Text', '#ffffff', 'accent')}
      </div>
      <div class="bp-actions">
        <button class="bp-btn" data-action="reset-palette">Reset palette</button>
      </div>
    </div>

    <div class="bp-tp-section">
      <h2>Background image or video</h2>
      <div class="bp-bg-controls">
        <div class="bp-bg-preview">
          ${custom.backgroundImage || custom.backgroundVideoId ? '' : 'No background set'}
        </div>
        <div class="bp-bg-row">
          <input type="file" accept="image/*,video/mp4,video/webm" data-bg-file />
          <div class="bp-mode-row">
            <label>Layout
              <select data-bg-mode>
                <option value="cover" ${custom.backgroundMode === 'cover' || !custom.backgroundMode ? 'selected' : ''}>Fill (cover)</option>
                <option value="contain" ${custom.backgroundMode === 'contain' ? 'selected' : ''}>Fit (contain)</option>
                <option value="tile" ${custom.backgroundMode === 'tile' ? 'selected' : ''}>Tile (image only)</option>
              </select>
            </label>
          </div>
          <button class="bp-btn bp-btn-danger" data-action="remove-bg" ${custom.backgroundImage || custom.backgroundVideoId ? '' : 'disabled'}>Remove background</button>
        </div>
        <p class="bp-tp-sub" style="margin: 2px 0 0 0;">Animated wallpapers: upload an .mp4 / .webm. Large files play smoother when downscaled to 720p first.</p>
        <div class="bp-bg-row">
          <label class="bp-brightness-label">Brightness
            <input type="range" min="0" max="200" step="1"
                   value="${clampBrightnessForUI(custom.backgroundBrightness)}"
                   data-bg-brightness />
            <span class="bp-num-input">
              <input type="number" min="0" max="200" step="1" inputmode="numeric"
                     value="${clampBrightnessForUI(custom.backgroundBrightness)}"
                     data-bg-brightness-num aria-label="Brightness percent" />%
            </span>
          </label>
        </div>
        ${custom.backgroundVideoId ? `
        <div class="bp-bg-row">
          <label class="bp-brightness-label">Video volume
            <input type="range" min="0" max="100" step="1"
                   value="${clampVolumeForUI(custom.backgroundVideoVolume)}"
                   data-bg-volume />
            <span class="bp-num-input">
              <input type="number" min="0" max="100" step="1" inputmode="numeric"
                     value="${clampVolumeForUI(custom.backgroundVideoVolume)}"
                     data-bg-volume-num aria-label="Video volume percent" />%
            </span>
          </label>
        </div>
        <p class="bp-tp-sub" style="margin: 2px 0 0 0;">Muted by default. Audio is silenced automatically while the browser window is in the background.</p>` : ''}
        <div class="bp-status"></div>
      </div>
    </div>

    <div class="bp-tp-section">
      <h2>Theme schedule</h2>
      <label class="bp-schedule-toggle">
        <input type="checkbox" data-schedule-enabled ${schedule.enabled ? 'checked' : ''} />
        Enable automatic theme schedule
      </label>
      <div class="bp-schedule-grid">
        ${scheduleRows}
      </div>
      <div class="bp-actions">
        <button class="bp-btn" type="button" data-schedule-add>Add slot</button>
      </div>
      <div class="bp-schedule-note">${escapeHtml(scheduleNote)}</div>
    </div>

    <div class="bp-draft-bar" data-draft-bar>
      <button class="bp-btn bp-btn-primary" data-action="apply">Apply</button>
      <button class="bp-btn" data-action="discard">Discard</button>
      <span class="bp-dirty-label">Unsaved changes — Apply to save them to a preset.</span>
    </div>
  `;

  // Data-URL backgrounds can't ride inside a style attribute via innerHTML.
  // Poster/still paints onto the box; a video preset additionally mounts a
  // muted looping <video> over it (loaded async from IndexedDB).
  {
    const preview = page.querySelector<HTMLElement>('.bp-bg-preview');
    if (preview) {
      if (custom.backgroundImage) {
        preview.style.backgroundImage = `url(${JSON.stringify(custom.backgroundImage)})`;
      }
      if (custom.backgroundVideoId) {
        void mountPreviewVideo(preview, custom.backgroundVideoId);
      }
    }
  }
  // Paint each user preset's swatch with its own backgroundImage when set.
  for (const id of userThemes.order) {
    const entry = userThemes.entries[id];
    if (!entry?.theme.backgroundImage) continue;
    const swatch = page.querySelector<HTMLElement>(
      `[data-user-preset="${id}"] .bp-preset-swatch`
    );
    if (!swatch) continue;
    swatch.setAttribute('data-has-image', '1');
    swatch.style.backgroundImage = `url(${JSON.stringify(entry.theme.backgroundImage)})`;
  }

  // ── Draft state ────────────────────────────────────────────────────────
  // The draft mirrors every editable field. Apply commits it to either the
  // active user preset (Overwrite) or a new one (New). Cancel/Discard reverts.
  const draft: CustomTheme = { ...custom };
  // Mutable so instant image commits can rebaseline the "dirty" comparison
  // for the backgroundImage field while leaving palette dirtiness intact.
  let initialSnapshot = JSON.stringify(draft);
  const draftBar = page.querySelector<HTMLElement>('[data-draft-bar]');

  const markDirty = () => {
    const dirty = JSON.stringify(draft) !== initialSnapshot;
    draftBar?.classList.toggle('bp-dirty', dirty);
    if (dirty) {
      setPreviewTheme(draft);
      setBackgroundImagePreview(draft);
    } else {
      setPreviewTheme(null);
      setBackgroundImagePreview(null);
    }
  };

  // Lightweight dirty-bar toggle for the brightness/volume sliders. The overlay
  // is already updated live by setBackgroundBrightnessPreview/VolumePreview
  // (which set a preview override the dispatch respects), so we must NOT call
  // the heavy markDirty here — rebuilding the whole theme CSS via
  // setPreviewTheme on every slider tick is what made dragging lag.
  const updateDirtyBar = () => {
    draftBar?.classList.toggle('bp-dirty', JSON.stringify(draft) !== initialSnapshot);
  };

  // Preset selection (click on a tile that isn't a tool button).
  for (const el of page.querySelectorAll<HTMLElement>('[data-preset]')) {
    el.addEventListener('click', async (e) => {
      if ((e.target as HTMLElement).closest('[data-tool]')) return; // handled below
      const dirty = JSON.stringify(draft) !== initialSnapshot;
      if (dirty) {
        const ok = await openConfirmModal({
          title: 'Discard unsaved changes?',
          body: 'You have unsaved theme edits. Switching presets will discard them.',
          confirmLabel: 'Discard and switch',
        });
        if (!ok) return;
      }
      setPreviewTheme(null);
      setBackgroundImagePreview(null);
      const id = el.dataset.preset!;
      await setSettings(activationPatch(id));
      setStatus(schedule.enabled ? `Updated current schedule slot: ${id}` : `Active theme: ${id}`);
      await render(page);
    });
  }

  // "+ New preset" tile — creates an empty user preset and activates it.
  // Mirrors the dirty-draft guard from preset selection so we don't silently
  // throw away unsaved edits.
  page.querySelector('[data-action="new-preset"]')?.addEventListener('click', async () => {
    const dirty = JSON.stringify(draft) !== initialSnapshot;
    if (dirty) {
      const ok = await openConfirmModal({
        title: 'Discard unsaved changes?',
        body: 'You have unsaved theme edits. Creating a new preset will discard them.',
        confirmLabel: 'Discard and create',
      });
      if (!ok) return;
    }
    const suggestion = suggestNextUserTheme(userThemes);
    const name = await openNameModal({
      title: 'Name your new theme',
      defaultValue: suggestion.name,
      confirmLabel: 'Create',
    });
    if (name == null) return;
    setPreviewTheme(null);
    setBackgroundImagePreview(null);
    const created = await createUserTheme(name, {});
    await setSettings(activationPatch(created.id));
    setStatus(`Created "${created.name}".`);
    await render(page);
  });

  // User-preset Rename / Delete.
  for (const btn of page.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tool = btn.dataset.tool!;
      const id = btn.dataset.id!;
      const entry = userThemes.entries[id];
      if (!entry) return;
      if (tool === 'rename') {
        const next = await openNameModal({
          title: 'Rename preset',
          defaultValue: entry.name,
          confirmLabel: 'Save',
        });
        if (next == null) return;
        await renameUserTheme(id, next);
        await render(page);
      } else if (tool === 'delete') {
        const ok = await openConfirmModal({
          title: 'Delete preset',
          body: `Delete "${entry.name}"? This can't be undone.`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
        await deleteUserTheme(id);
        await render(page);
      }
    });
  }

  // Color inputs.
  for (const row of page.querySelectorAll<HTMLElement>('.bp-color-row')) {
    const key = row.dataset.key as keyof CustomTheme;
    const mirror = row.dataset.mirrorTo as keyof CustomTheme | undefined;
    const colorEl = row.querySelector<HTMLInputElement>('[data-color-input]')!;
    const textEl = row.querySelector<HTMLInputElement>('[data-color-text]')!;

    const updateDraft = (value: string) => {
      const v = value || undefined;
      (draft as Record<string, string | undefined>)[key as string] = v;
      if (mirror) (draft as Record<string, string | undefined>)[mirror as string] = v;
      markDirty();
    };

    colorEl.addEventListener('input', () => {
      textEl.value = colorEl.value;
      updateDraft(colorEl.value);
    });
    textEl.addEventListener('input', () => {
      const norm = normalizeColor(textEl.value);
      if (norm) colorEl.value = norm;
      updateDraft(textEl.value);
    });
  }

  // Reset palette (clears just the color fields in the draft).
  page.querySelector('[data-action="reset-palette"]')?.addEventListener('click', () => {
    draft.background = undefined;
    draft.nav = undefined;
    draft.text = undefined;
    draft.accent = undefined;
    for (const row of page.querySelectorAll<HTMLElement>('.bp-color-row')) {
      const colorEl = row.querySelector<HTMLInputElement>('[data-color-input]');
      const textEl = row.querySelector<HTMLInputElement>('[data-color-text]');
      if (textEl) textEl.value = '';
      if (colorEl) colorEl.value = colorEl.defaultValue;
    }
    markDirty();
    setStatus('Palette cleared — Apply to save.');
  });

  // Background upload — image or video. Commits to the active preset instantly.
  // On a built-in (which can't be overwritten) we have to land somewhere, so
  // fall back to a name prompt and create a new preset that carries both the
  // asset and the in-progress palette draft.
  const fileEl = page.querySelector<HTMLInputElement>('[data-bg-file]');
  fileEl?.addEventListener('change', async () => {
    const f = fileEl.files?.[0];
    if (!f) return;

    // ── Video path ────────────────────────────────────────────────────────
    if (VIDEO_MIME_RE.test(f.type)) {
      if (f.size > MAX_VIDEO_BYTES) {
        setStatus(`Video is ${formatBytes(f.size)}. Please pick one under ${formatBytes(MAX_VIDEO_BYTES)}.`);
        fileEl.value = '';
        return;
      }
      setStatus('Storing video…');
      const videoId = await putVideo(f);
      const poster = await captureVideoPoster(f);

      if (activeEntry) {
        await setCustomThemeVideo(videoId, poster);
        fileEl.value = '';
        setStatus(`Video saved to "${activeEntry.name}".`);
        // Unlike the image path (which updates in place to preserve palette
        // dirtiness), re-render so the new "Video volume" slider appears for
        // the now-video background. The live overlay updates via the storage
        // write → onCustomThemeChanged → applyCurrent.
        await render(page);
        return;
      }

      // Built-in active — needs a target preset.
      const suggestion = suggestNextUserTheme(userThemes);
      const name = await openNameModal({
        title: 'Name your new theme',
        defaultValue: suggestion.name,
        confirmLabel: 'Create',
      });
      if (name == null) {
        await deleteVideo(videoId); // user backed out — don't leave an orphan blob
        setStatus('');
        fileEl.value = '';
        return;
      }
      const created = await createUserTheme(name, {
        ...draft,
        backgroundVideoId: videoId,
        backgroundImage: poster,
      });
      await setSettings(activationPatch(created.id));
      setPreviewTheme(null);
      setBackgroundImagePreview(null);
      setStatus(`Saved as "${created.name}".`);
      await render(page);
      return;
    }

    // ── Image path ────────────────────────────────────────────────────────
    if (f.size > MAX_IMAGE_BYTES) {
      setStatus(`Image is ${formatBytes(f.size)}. Please pick one under ${formatBytes(MAX_IMAGE_BYTES)}.`);
      return;
    }
    setStatus('Reading image…');
    const dataUrl = await fileToDataUrl(f);

    if (activeEntry) {
      // setCustomThemeBackground clears any prior video + deletes its blob.
      await setCustomThemeBackground(dataUrl);
      draft.backgroundImage = dataUrl;
      draft.backgroundVideoId = undefined;
      custom.backgroundImage = dataUrl;
      custom.backgroundVideoId = undefined;
      // Keep the image field out of "dirty" — palette dirtiness is preserved.
      initialSnapshot = JSON.stringify({
        ...JSON.parse(initialSnapshot),
        backgroundImage: dataUrl,
        backgroundVideoId: undefined,
      });
      const preview = page.querySelector<HTMLElement>('.bp-bg-preview');
      if (preview) {
        clearPreviewVideo(preview);
        preview.style.backgroundImage = `url(${JSON.stringify(dataUrl)})`;
        preview.textContent = '';
      }
      page.querySelector<HTMLButtonElement>('[data-action="remove-bg"]')?.removeAttribute('disabled');
      const swatch = page.querySelector<HTMLElement>(
        `[data-user-preset="${activeEntry.id}"] .bp-preset-swatch`
      );
      if (swatch) {
        swatch.setAttribute('data-has-image', '1');
        swatch.style.backgroundImage = `url(${JSON.stringify(dataUrl)})`;
      }
      markDirty();
      setStatus(`Image saved to "${activeEntry.name}".`);
      return;
    }

    // Built-in active — needs a target preset.
    const suggestion = suggestNextUserTheme(userThemes);
    const name = await openNameModal({
      title: 'Name your new theme',
      defaultValue: suggestion.name,
      confirmLabel: 'Create',
    });
    if (name == null) {
      setStatus('');
      fileEl.value = '';
      return;
    }
    const created = await createUserTheme(name, {
      ...draft,
      backgroundImage: dataUrl,
      backgroundVideoId: undefined,
    });
    await setSettings(activationPatch(created.id));
    setPreviewTheme(null);
    setBackgroundImagePreview(null);
    setStatus(`Saved as "${created.name}".`);
    await render(page);
  });

  // Background remove — instant commit to the active preset; clears image and
  // video. Built-ins never have a background to remove, so the button is
  // disabled in that case (see the `disabled` attribute in the markup above).
  page.querySelector('[data-action="remove-bg"]')?.addEventListener('click', async () => {
    if (!activeEntry) return;
    await removeCustomThemeBackground();
    draft.backgroundImage = undefined;
    draft.backgroundVideoId = undefined;
    custom.backgroundImage = undefined;
    custom.backgroundVideoId = undefined;
    initialSnapshot = JSON.stringify({
      ...JSON.parse(initialSnapshot),
      backgroundImage: undefined,
      backgroundVideoId: undefined,
    });
    const preview = page.querySelector<HTMLElement>('.bp-bg-preview');
    if (preview) {
      clearPreviewVideo(preview);
      preview.style.backgroundImage = '';
      preview.textContent = 'No background set';
    }
    page.querySelector<HTMLButtonElement>('[data-action="remove-bg"]')?.setAttribute('disabled', 'true');
    const swatch = page.querySelector<HTMLElement>(
      `[data-user-preset="${activeEntry.id}"] .bp-preset-swatch`
    );
    if (swatch) {
      swatch.removeAttribute('data-has-image');
      swatch.style.backgroundImage = '';
    }
    markDirty();
    setStatus(`Background removed from "${activeEntry.name}".`);
  });

  // Brightness — slider + exact-% number input, two-way synced. Preview live
  // while dragging/typing, commit on Apply.
  wireSliderNumber(
    page.querySelector<HTMLInputElement>('[data-bg-brightness]'),
    page.querySelector<HTMLInputElement>('[data-bg-brightness-num]'),
    clampBrightnessForUI,
    (v) => {
      setBackgroundBrightnessPreview(v);
      draft.backgroundBrightness = v;
      updateDirtyBar();
    }
  );

  // Video volume — same slider + number pairing (shown only for video
  // backgrounds). Default 0 (muted); auto-muted on window blur.
  wireSliderNumber(
    page.querySelector<HTMLInputElement>('[data-bg-volume]'),
    page.querySelector<HTMLInputElement>('[data-bg-volume-num]'),
    clampVolumeForUI,
    (v) => {
      setBackgroundVolumePreview(v);
      draft.backgroundVideoVolume = v;
      updateDirtyBar();
    }
  );

  // Layout mode.
  page.querySelector<HTMLSelectElement>('[data-bg-mode]')?.addEventListener('change', (e) => {
    const mode = (e.target as HTMLSelectElement).value as 'cover' | 'contain' | 'tile';
    draft.backgroundMode = mode;
    markDirty();
  });

  const saveSchedule = async (
    nextSchedule: ThemeSchedule,
    options: { rebuild?: boolean } = {}
  ): Promise<void> => {
    const sanitized = sanitizeThemeSchedule(nextSchedule, userThemes);
    const resolution = resolveThemeSchedule({ ...settings, themeSchedule: sanitized }, userThemes);
    await setSettings({
      themeSchedule: sanitized,
      ...(sanitized.enabled && resolution ? { themeId: resolution.themeId } : {}),
    });
    if (options.rebuild) {
      await render(page);
      return;
    }
    // For label/time/theme tweaks the slot DOM already reflects the user's
    // input — only the schedule-note text needs refreshing. Re-rendering the
    // whole page here would steal focus from the input the user just left.
    const noteEl = page.querySelector<HTMLElement>('.bp-schedule-note');
    if (noteEl) {
      noteEl.textContent =
        sanitized.enabled && resolution
          ? `Currently using ${scheduleChoices.find((c) => c.id === resolution.themeId)?.name ?? resolution.themeId} (${resolution.slotLabel}) until ${resolution.nextStartsAt}.`
          : 'Schedule is off. Your selected preset stays active until you change it.';
    }
  };

  page.querySelector<HTMLInputElement>('[data-schedule-enabled]')?.addEventListener('change', async (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    await saveSchedule({ ...schedule, enabled }, { rebuild: true });
  });

  for (const select of page.querySelectorAll<HTMLSelectElement>('[data-schedule-theme]')) {
    select.addEventListener('change', async () => {
      const slotId = select.closest<HTMLElement>('[data-schedule-slot]')?.dataset.scheduleSlot;
      if (!slotId) return;
      await saveSchedule({
        ...schedule,
        slots: schedule.slots.map((slot) =>
          slot.id === slotId ? { ...slot, themeId: select.value } : slot
        ),
      });
    });
  }

  for (const input of page.querySelectorAll<HTMLInputElement>('[data-schedule-time]')) {
    input.addEventListener('change', async () => {
      const slotId = input.closest<HTMLElement>('[data-schedule-slot]')?.dataset.scheduleSlot;
      if (!slotId) return;
      await saveSchedule({
        ...schedule,
        slots: schedule.slots.map((slot) =>
          slot.id === slotId ? { ...slot, startsAt: input.value || slot.startsAt } : slot
        ),
      });
    });
  }

  for (const input of page.querySelectorAll<HTMLInputElement>('[data-schedule-label]')) {
    input.addEventListener('change', async () => {
      const slotId = input.closest<HTMLElement>('[data-schedule-slot]')?.dataset.scheduleSlot;
      if (!slotId) return;
      await saveSchedule({
        ...schedule,
        slots: schedule.slots.map((slot) =>
          slot.id === slotId ? { ...slot, label: input.value.trim() || slot.label } : slot
        ),
      });
    });
  }

  page.querySelector('[data-schedule-add]')?.addEventListener('click', async () => {
    const nextIndex = schedule.slots.length + 1;
    await saveSchedule(
      {
        ...schedule,
        slots: [
          ...schedule.slots,
          {
            id: `slot-${Date.now().toString(36)}`,
            label: `Slot ${nextIndex}`,
            themeId: schedule.slots[schedule.slots.length - 1]?.themeId ?? 'default',
            startsAt: `${String((7 + (nextIndex - 1) * 4) % 24).padStart(2, '0')}:00`,
          },
        ],
      },
      { rebuild: true }
    );
  });

  for (const btn of page.querySelectorAll<HTMLButtonElement>('[data-schedule-remove]')) {
    btn.addEventListener('click', async () => {
      const slotId = btn.dataset.scheduleRemove;
      if (!slotId || schedule.slots.length <= 2) return;
      await saveSchedule(
        {
          ...schedule,
          slots: schedule.slots.filter((slot) => slot.id !== slotId),
        },
        { rebuild: true }
      );
    });
  }

  // ── Apply / Discard ────────────────────────────────────────────────────

  page.querySelector('[data-action="discard"]')?.addEventListener('click', async () => {
    setPreviewTheme(null);
    setBackgroundImagePreview(null);
    setStatus('Changes discarded.');
    await render(page);
  });

  page.querySelector('[data-action="apply"]')?.addEventListener('click', async () => {
    // On a user preset → overwrite in place. On a built-in (which can't be
    // overwritten) → fall through to a name prompt so the user lands on a new
    // user preset rather than getting nothing.
    if (activeEntry) {
      await overwriteUserTheme(activeEntry.id, draft);
      setPreviewTheme(null);
      setBackgroundImagePreview(null);
      setStatus(`Saved to "${activeEntry.name}".`);
      await render(page);
      return;
    }
    const suggestion = suggestNextUserTheme(userThemes);
    const name = await openNameModal({
      title: 'Name your new theme',
      defaultValue: suggestion.name,
      confirmLabel: 'Create',
    });
    if (name == null) {
      setStatus('Apply cancelled — your edits are still pending.');
      return;
    }
    const created = await createUserTheme(name, draft);
    await setSettings(activationPatch(created.id));
    setPreviewTheme(null);
    setBackgroundImagePreview(null);
    setStatus(`Saved as "${created.name}".`);
    await render(page);
  });

  // If we were called via re-render mid-edit, restore the dirty bar state.
  markDirty();
  // Snapshot for the maybeRerenderForSettings short-circuit.
  lastRenderedThemeId = activeId;
}

function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

/** Removes any preview <video> from the box and revokes its object URL. */
function clearPreviewVideo(preview: HTMLElement): void {
  const existing = preview.querySelector<HTMLVideoElement>('video.bp-bg-preview-video');
  if (existing) {
    const url = existing.dataset.objurl;
    if (url) URL.revokeObjectURL(url);
    existing.remove();
  }
}

/** Mounts a muted looping preview <video> for a stored video id into the box. */
async function mountPreviewVideo(preview: HTMLElement, videoId: string): Promise<void> {
  const blob = await getVideo(videoId);
  if (!blob) return;
  clearPreviewVideo(preview);
  preview.textContent = '';
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.className = 'bp-bg-preview-video';
  v.autoplay = true;
  v.loop = true;
  v.muted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.src = url;
  v.dataset.objurl = url;
  v.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;';
  // The preview box is positioned in CSS; ensure the video sits inside it.
  if (getComputedStyle(preview).position === 'static') preview.style.position = 'relative';
  preview.appendChild(v);
  void v.play().catch(() => {});
}

/**
 * Best-effort first-frame capture for a video file → PNG data URL, used as the
 * theme's poster so the overlay shows something before the blob loads. Returns
 * `undefined` if the browser can't decode/seek the file. Capped to a modest
 * size so the poster doesn't bloat `chrome.storage`.
 */
function captureVideoPoster(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    let done = false;
    const finish = (result: string | undefined) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(result);
    };
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    v.src = url;
    v.onloadeddata = () => {
      try {
        const vw = v.videoWidth || 1280;
        const vh = v.videoHeight || 720;
        const scale = Math.min(1, 1280 / vw);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(vw * scale);
        canvas.height = Math.round(vh * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) return finish(undefined);
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', 0.7));
      } catch {
        finish(undefined);
      }
    };
    v.onerror = () => finish(undefined);
    // Safety timeout so a stuck decode never hangs the upload flow.
    setTimeout(() => finish(undefined), 4000);
  });
}

/**
 * Two-way binds a range slider to an exact-% number input. Dragging the slider
 * previews live (and fills the number); typing a number does NOT preview per
 * keystroke — it only applies on `change` (blur / Enter), so the page isn't
 * updated mid-type. Both clamp through `clamp` and run `apply` (preview + draft
 * + dirty bar).
 */
function wireSliderNumber(
  slider: HTMLInputElement | null,
  num: HTMLInputElement | null,
  clamp: (v: number | undefined) => number,
  apply: (v: number) => void
): void {
  if (!slider) return;
  slider.addEventListener('input', () => {
    const v = clamp(Number(slider.value));
    if (num) num.value = String(v);
    apply(v);
  });
  if (!num) return;
  // Commit-only: wait until the user finishes typing (blur / Enter) before
  // applying, instead of previewing on every keystroke.
  num.addEventListener('change', () => {
    const v = clamp(Number(num.value));
    num.value = String(v); // normalize on commit (clamps / fills blanks)
    slider.value = String(v);
    apply(v);
  });
}

function clampBrightnessForUI(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 100;
  return Math.max(0, Math.min(200, Math.round(v)));
}

function clampVolumeForUI(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function normalizeColor(v: string): string {
  const t = v.trim();
  if (/^#[0-9a-f]{6}$/i.test(t)) return t;
  if (/^#[0-9a-f]{3}$/i.test(t)) {
    return '#' + t.slice(1).split('').map((c) => c + c).join('');
  }
  return '';
}

export function run(): void {
  ensureStyle();
  const host = findHomeContentHost();
  if (!host) return;
  void runAsync(host);
}

async function runAsync(host: HTMLElement): Promise<void> {
  const settings = await getSettings();
  const allowed = settings.showThemes && isThemesRoute() && isHomePath();
  if (!allowed) {
    const page = document.getElementById(PAGE_ID);
    if (page) {
      page.remove();
      restoreHomeContent();
      setPreviewTheme(null);
      setBackgroundImagePreview(null);
    }
    return;
  }
  hideHomeContent(host);
  void mountPage(host);
}

/**
 * Tracks the themeId that the current rendered page represents. When
 * onSettingsChanged fires for a reason that didn't move the active theme
 * (the user just tweaked a schedule slot's label/time/theme), skip the
 * full re-render — the schedule form already reflects what the user
 * typed, and a re-render would steal focus.
 */
let lastRenderedThemeId: string | null = null;

let initialized = false;
export function install(): void {
  if (initialized) return;
  initialized = true;
  window.addEventListener('hashchange', () => run());
  window.addEventListener('popstate', () => run());
  // External-source updates (theme scheduler boundary, customize-mode preset
  // creation, etc.) should refresh the page — but only when the user has no
  // pending unsaved edits AND when something the page actually displays has
  // changed. Schedule-only edits skip via the themeId compare below.
  onSettingsChanged((s) => maybeRerenderForSettings(s));
  onUserThemesChanged(() => maybeRerender());
}

function maybeRerenderForSettings(s: { themeId: string }): void {
  if (s.themeId === lastRenderedThemeId) return; // schedule-only tweak
  maybeRerender();
}

function maybeRerender(): void {
  const page = document.getElementById(PAGE_ID);
  if (!page || !isThemesRoute() || !isHomePath()) return;
  // Dirty bar present means an Apply is pending — re-rendering would discard.
  if (page.querySelector('.bp-draft-bar.bp-dirty')) return;
  void render(page);
}
