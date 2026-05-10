/**
 * Renders the SviBlox Themes page as an overlay inside the Roblox home
 * content area, triggered by `location.hash === '#bloxplus-themes'`.
 * Roblox's left nav, header, and chat remain functional; only the home
 * main content gets replaced.
 */

import { getSettings, setSettings } from '@/storage/settingsStore';
import {
  getCustomTheme,
  setCustomTheme,
  setCustomThemeBackground,
  removeCustomThemeBackground,
  clearCustomTheme,
} from '@/storage/themeStore';
import { getPresets } from './themeInjector';
import { CustomTheme } from '@/types';

const PAGE_ID = 'bloxplus-themes-page';
const STYLE_ID = 'bloxplus-themes-page-style';
const HIDE_ATTR = 'data-bp-themes-hidden';
const MAX_IMAGE_BYTES = 16 * 1024 * 1024; // Supports typical compressed 4K backgrounds.

function isThemesRoute(): boolean {
  const h = location.hash.replace(/^#/, '');
  return h === 'bloxplus-themes';
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${PAGE_ID} {
      padding: 24px 0;
      color: inherit;
      font-family: inherit;
    }
    #${PAGE_ID} h1 { font-size: 28px; margin: 0 0 8px 0; font-weight: 700; }
    #${PAGE_ID} p.bp-tp-sub { margin: 0 0 24px 0; opacity: 0.7; font-size: 14px; }

    #${PAGE_ID} .bp-tp-section {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 20px;
    }
    #${PAGE_ID} .bp-tp-section h2 {
      font-size: 18px; margin: 0 0 14px 0; font-weight: 600;
    }

    #${PAGE_ID} .bp-presets {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 12px;
    }
    #${PAGE_ID} .bp-preset {
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
    #${PAGE_ID} .bp-preset-name { font-weight: 600; font-size: 14px; }
    #${PAGE_ID} .bp-preset-id { font-size: 11px; opacity: 0.55; }

    #${PAGE_ID} .bp-color-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 14px;
    }
    #${PAGE_ID} .bp-color-row {
      display: flex; align-items: center; gap: 10px;
    }
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

    #${PAGE_ID} .bp-bg-controls {
      display: flex; flex-direction: column; gap: 12px;
    }
    #${PAGE_ID} .bp-bg-preview {
      width: 100%; max-height: 220px; min-height: 120px;
      background: #15171c center/cover no-repeat;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 6px;
      display: flex; align-items: center; justify-content: center;
      font-size: 12px; opacity: 0.7;
    }
    #${PAGE_ID} .bp-bg-row {
      display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
    }

    #${PAGE_ID} .bp-actions {
      display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px;
    }
    #${PAGE_ID} button.bp-btn {
      padding: 8px 14px;
      font-size: 13px;
      font-weight: 500;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.18);
      background: rgba(255,255,255,0.06);
      color: inherit;
      cursor: pointer;
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
    #${PAGE_ID} .bp-status {
      font-size: 12px; opacity: 0.7; margin-top: 8px; min-height: 14px;
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

function hideHomeContent(host: HTMLElement): void {
  for (const child of host.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.id === PAGE_ID) continue;
    if (!child.hasAttribute(HIDE_ATTR)) {
      child.style.display = 'none';
      child.setAttribute(HIDE_ATTR, '1');
    }
  }
}

function restoreHomeContent(): void {
  for (const el of document.querySelectorAll(`[${HIDE_ATTR}]`)) {
    if (el instanceof HTMLElement) {
      el.style.display = '';
      el.removeAttribute(HIDE_ATTR);
    }
  }
}

async function mountPage(host: HTMLElement): Promise<void> {
  let page = document.getElementById(PAGE_ID);
  if (page) {
    // Already mounted — make sure it's still attached to the home host
    // (in case React replaced the home container) and exit. Do NOT re-render,
    // because that would wipe inputs/focus on every mutation tick.
    if (page.parentElement !== host) host.appendChild(page);
    return;
  }
  page = document.createElement('div');
  page.id = PAGE_ID;
  host.appendChild(page);
  await render(page);
}

async function render(page: HTMLElement): Promise<void> {
  const settings = await getSettings();
  const custom = await getCustomTheme();
  const presets = getPresets();
  const activeId = settings.themeId;

  const setStatus = (msg: string) => {
    const el = page.querySelector('.bp-status');
    if (el) el.textContent = msg;
  };

  const colorRow = (key: keyof CustomTheme, label: string, fallback: string): string => {
    const v = (custom[key] as string | undefined) ?? '';
    return `
      <div class="bp-color-row" data-key="${key}">
        <label>${label}</label>
        <input type="color" value="${normalizeColor(v) || fallback}" data-color-input />
        <input type="text" value="${v}" placeholder="${fallback}" data-color-text />
      </div>
    `;
  };

  page.innerHTML = `
    <h1>Themes</h1>
    <p class="bp-tp-sub">Customise SviBlox's look across roblox.com. Select a built-in preset, mix your own palette, or upload an image to use as a background.</p>

    <div class="bp-tp-section">
      <h2>Built-in presets</h2>
      <div class="bp-presets">
        ${presets
          .map(
            (p) => `
          <div class="bp-preset ${p.id === activeId ? 'bp-active' : ''}" data-preset="${p.id}"
               style="--s-bg:${p.vars?.background ?? '#15171c'}; --s-card:${p.vars?.card ?? '#2a2d35'};">
            <div class="bp-preset-swatch"></div>
            <div class="bp-preset-name">${p.name}</div>
            <div class="bp-preset-id">${p.id}</div>
          </div>
        `
          )
          .join('')}
        <div class="bp-preset ${activeId === 'custom' ? 'bp-active' : ''}" data-preset="custom"
             style="--s-bg:${custom.background ?? '#222'}; --s-card:${custom.card ?? '#444'};">
          <div class="bp-preset-swatch"></div>
          <div class="bp-preset-name">Custom</div>
          <div class="bp-preset-id">your palette below</div>
        </div>
      </div>
    </div>

    <div class="bp-tp-section">
      <h2>Custom palette</h2>
      <div class="bp-color-grid">
        ${colorRow('background', 'Background', '#0e0f12')}
        ${colorRow('card', 'Card / panel', '#15171c')}
        ${colorRow('text', 'Text', '#e6e6e6')}
        ${colorRow('accent', 'Accent (links, buttons)', '#4a90e2')}
        ${colorRow('border', 'Border', '#202229')}
      </div>
      <div class="bp-actions">
        <button class="bp-btn bp-btn-primary" data-action="apply-custom">Use my palette</button>
        <button class="bp-btn" data-action="reset-palette">Reset palette</button>
      </div>
    </div>

    <div class="bp-tp-section">
      <h2>Background image</h2>
      <div class="bp-bg-controls">
        <div class="bp-bg-preview" style="${
          custom.backgroundImage
            ? `background-image: url(${JSON.stringify(custom.backgroundImage)});`
            : ''
        }">
          ${custom.backgroundImage ? '' : 'No background image set'}
        </div>
        <div class="bp-bg-row">
          <input type="file" accept="image/*" data-bg-file />
          <div class="bp-mode-row">
            <label>Layout
              <select data-bg-mode>
                <option value="cover" ${custom.backgroundMode === 'cover' || !custom.backgroundMode ? 'selected' : ''}>Fill (cover)</option>
                <option value="contain" ${custom.backgroundMode === 'contain' ? 'selected' : ''}>Fit (contain)</option>
                <option value="tile" ${custom.backgroundMode === 'tile' ? 'selected' : ''}>Tile</option>
              </select>
            </label>
          </div>
          <button class="bp-btn bp-btn-danger" data-action="remove-bg" ${custom.backgroundImage ? '' : 'disabled'}>Remove image</button>
        </div>
        <div class="bp-status"></div>
      </div>
    </div>
  `;

  // --- Wiring ---

  // Preset selection.
  for (const el of page.querySelectorAll<HTMLElement>('[data-preset]')) {
    el.addEventListener('click', async () => {
      const id = el.dataset.preset!;
      await setSettings({ themeId: id });
      setStatus(`Active theme: ${id}`);
      await render(page); // refresh active state
    });
  }

  // Color inputs (both <input type=color> and <input type=text> linked).
  for (const row of page.querySelectorAll<HTMLElement>('.bp-color-row')) {
    const key = row.dataset.key as keyof CustomTheme;
    const colorEl = row.querySelector<HTMLInputElement>('[data-color-input]')!;
    const textEl = row.querySelector<HTMLInputElement>('[data-color-text]')!;
    colorEl.addEventListener('input', () => {
      textEl.value = colorEl.value;
    });
    textEl.addEventListener('input', () => {
      const norm = normalizeColor(textEl.value);
      if (norm) colorEl.value = norm;
    });
    const commit = () => void setCustomTheme({ [key]: textEl.value || colorEl.value } as Partial<CustomTheme>);
    colorEl.addEventListener('change', commit);
    textEl.addEventListener('change', commit);
  }

  // Action buttons.
  page.querySelector('[data-action="apply-custom"]')?.addEventListener('click', async () => {
    await setSettings({ themeId: 'custom' });
    setStatus('Switched to your custom palette.');
    await render(page);
  });
  page.querySelector('[data-action="reset-palette"]')?.addEventListener('click', async () => {
    await clearCustomTheme();
    setStatus('Custom palette cleared.');
    await render(page);
  });
  page.querySelector('[data-action="remove-bg"]')?.addEventListener('click', async () => {
    await removeCustomThemeBackground();
    setStatus('Background image removed.');
    await render(page);
  });

  // File upload.
  const fileEl = page.querySelector<HTMLInputElement>('[data-bg-file]');
  fileEl?.addEventListener('change', async () => {
    const f = fileEl.files?.[0];
    if (!f) return;
    if (f.size > MAX_IMAGE_BYTES) {
      setStatus(`Image is ${formatBytes(f.size)}. Please pick one under ${formatBytes(MAX_IMAGE_BYTES)}.`);
      return;
    }
    setStatus('Reading image…');
    const dataUrl = await fileToDataUrl(f);
    await setCustomThemeBackground(dataUrl);
    if ((await getSettings()).themeId !== 'custom') await setSettings({ themeId: 'custom' });
    setStatus(`Image loaded (${formatBytes(f.size)}). Active theme set to Custom.`);
    await render(page);
  });

  // Layout mode.
  page
    .querySelector<HTMLSelectElement>('[data-bg-mode]')
    ?.addEventListener('change', async (e) => {
      const mode = (e.target as HTMLSelectElement).value as 'cover' | 'contain' | 'tile';
      await setCustomTheme({ backgroundMode: mode });
      setStatus(`Layout: ${mode}`);
    });
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

function normalizeColor(v: string): string {
  // Returns a hex (#RRGGBB) the <input type="color"> can accept, or '' if not parseable.
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
  if (!isThemesRoute()) {
    // Tear down if previously mounted.
    const page = document.getElementById(PAGE_ID);
    if (page) {
      page.remove();
      restoreHomeContent();
    }
    return;
  }
  hideHomeContent(host);
  void mountPage(host);
}

let initialized = false;
export function install(): void {
  if (initialized) return;
  initialized = true;
  window.addEventListener('hashchange', () => run());
  window.addEventListener('popstate', () => run());
}
