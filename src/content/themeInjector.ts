import { getSettings, onSettingsChanged } from '@/storage/settingsStore';
import { getCustomTheme, onCustomThemeChanged } from '@/storage/themeStore';
import { CustomTheme } from '@/types';

const STYLE_ID = 'bloxplus-theme-style';
const BG_OVERLAY_ID = 'bloxplus-theme-bg';

interface PresetTheme {
  id: string;
  name: string;
  vars?: Partial<Record<'background' | 'card' | 'text' | 'accent' | 'border', string>>;
  bgImage?: string;
}

const PRESETS: PresetTheme[] = [
  { id: 'default', name: 'Default' },
  {
    id: 'dark-plus',
    name: 'Dark+',
    vars: {
      background: '#0e0f12',
      card: '#15171c',
      text: '#e6e6e6',
      accent: '#4a90e2',
      border: 'rgba(255,255,255,0.08)',
    },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    vars: {
      background: '#05060a',
      card: '#0c0e15',
      text: '#cfd6e4',
      accent: '#7a5af8',
      border: 'rgba(255,255,255,0.06)',
    },
  },
  {
    id: 'soft-blue',
    name: 'Soft Blue',
    vars: {
      background: '#0f172a',
      card: '#1e293b',
      text: '#e2e8f0',
      accent: '#38bdf8',
      border: 'rgba(255,255,255,0.1)',
    },
  },
  {
    id: 'high-contrast',
    name: 'High Contrast',
    vars: {
      background: '#000000',
      card: '#0a0a0a',
      text: '#ffffff',
      accent: '#ffd400',
      border: '#ffffff',
    },
  },
];

export function getPresets(): PresetTheme[] {
  return PRESETS;
}

function buildCss(themeId: string, custom: CustomTheme): string {
  const preset = PRESETS.find((p) => p.id === themeId);
  if (!preset && themeId !== 'custom') return '';

  const vars =
    themeId === 'custom'
      ? {
          background: custom.background,
          card: custom.card,
          text: custom.text,
          accent: custom.accent,
          border: custom.border,
        }
      : preset?.vars ?? {};

  const cssVars = Object.entries(vars)
    .filter(([, v]) => !!v)
    .map(([k, v]) => `--bp-${k}: ${v};`)
    .join('\n      ');

  if (!cssVars) return '';

  return `
    body {
      ${cssVars}
    }
    body.dark-theme,
    body.light-theme,
    #wrap.wrap.no-gutter-ads {
      ${vars.background ? `background-color: var(--bp-background) !important;` : ''}
      ${vars.text ? `color: var(--bp-text) !important;` : ''}
    }
    /* Cards / panels — Roblox uses .section, .container-list, .border, etc. */
    .section, .container-list, .game-card-container, .friends-carousel-container,
    .game-sort-carousel-wrapper, .badge-container, .stack,
    .game-about-container, .game-description-container,
    .game-stat-container, .game-stats-container,
    .social-links .contents {
      ${vars.card ? `background-color: var(--bp-card) !important;` : ''}
    }
    /* Accent on links + active states. */
    a, .link, .text-link, .text-name, .nav-menu-active a {
      ${vars.accent ? `color: var(--bp-accent) !important;` : ''}
    }
    .btn-primary, .btn-cta-md, .btn-control-md.btn-primary-md {
      ${vars.accent ? `background-color: var(--bp-accent) !important;` : ''}
      ${vars.accent ? `border-color: var(--bp-accent) !important;` : ''}
    }
    /* Borders. */
    .border, .border-bottom, .border-top, .border-right, .border-left,
    .game-card-container, .stack-row {
      ${vars.border ? `border-color: var(--bp-border) !important;` : ''}
    }

    /* Readability panels: only active when a custom background image is set.
       Keep this scoped to text-heavy game-page surfaces that otherwise sit
       directly on top of photo backgrounds. */
    body.bp-has-bg-image .bp-badge-row,
    body.bp-has-bg-image .bp-badges-summary,
    body.bp-has-bg-image .bp-badges-controls,
    body.bp-has-bg-image .badge-container,
    body.bp-has-bg-image .btr-badges-container > *,
    body.bp-has-bg-image .game-about-container,
    body.bp-has-bg-image .game-description-container,
    body.bp-has-bg-image .game-stat-container,
    body.bp-has-bg-image .game-stats-container,
    body.bp-has-bg-image #bloxplus-dev-products-section,
    body.bp-has-bg-image #rbx-game-passes,
    body.bp-has-bg-image .social-links .contents {
      background-color: rgba(0, 0, 0, 0.55) !important;
      backdrop-filter: blur(8px) saturate(1.1);
      -webkit-backdrop-filter: blur(8px) saturate(1.1);
      border-radius: 8px;
      padding: 10px 12px;
      color: #fff !important;
    }
    body.bp-has-bg-image .bp-badge-row *,
    body.bp-has-bg-image .game-about-container *,
    body.bp-has-bg-image .game-description-container *,
    body.bp-has-bg-image .game-stat-container *,
    body.bp-has-bg-image .game-stats-container *,
    body.bp-has-bg-image #bloxplus-dev-products-section *,
    body.bp-has-bg-image #rbx-game-passes *,
    body.bp-has-bg-image .social-links .contents * {
      color: inherit !important;
    }
    body.bp-has-bg-image .bp-robux-cash:not(.bp-robux-cash-block) {
      background-color: rgba(0, 0, 0, 0.55) !important;
      backdrop-filter: blur(8px) saturate(1.1);
      -webkit-backdrop-filter: blur(8px) saturate(1.1);
      color: #fff !important;
      opacity: 1;
    }
    body.bp-has-bg-image .bp-robux-cash.bp-robux-cash-block {
      background-color: transparent !important;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      color: #fff !important;
      opacity: 1;
    }
    body.bp-has-bg-image .game-card-info,
    body.bp-has-bg-image .bp-fav-stats {
      display: inline-flex !important;
      align-items: center;
      gap: 5px;
      width: fit-content;
      max-width: 100%;
      margin-top: 4px;
      padding: 3px 6px;
      background-color: rgba(0, 0, 0, 0.55) !important;
      backdrop-filter: blur(8px) saturate(1.1);
      -webkit-backdrop-filter: blur(8px) saturate(1.1);
      border-radius: 6px;
      color: #fff !important;
    }
    body.bp-has-bg-image .game-card-info *,
    body.bp-has-bg-image .bp-fav-stats * {
      color: inherit !important;
    }
  `;
}

function applyBackgroundImage(custom: CustomTheme, themeId: string): void {
  const url = themeId === 'custom' ? custom.backgroundImage : undefined;
  document.body.classList.toggle('bp-has-bg-image', !!url);
  let bg = document.getElementById(BG_OVERLAY_ID);
  if (!url) {
    bg?.remove();
    return;
  }
  if (!bg) {
    bg = document.createElement('div');
    bg.id = BG_OVERLAY_ID;
    document.body.appendChild(bg);
  }
  const mode = custom.backgroundMode ?? 'cover';
  const repeat = mode === 'tile' ? 'repeat' : 'no-repeat';
  const size = mode === 'tile' ? 'auto' : mode;
  bg.setAttribute(
    'style',
    [
      'position: fixed',
      'inset: 0',
      'z-index: -1',
      'pointer-events: none',
      `background-image: url(${JSON.stringify(url)})`,
      `background-size: ${size}`,
      `background-repeat: ${repeat}`,
      'background-position: center center',
      'background-attachment: fixed',
    ].join(';')
  );
}

async function applyCurrent(): Promise<void> {
  const [settings, custom] = await Promise.all([getSettings(), getCustomTheme()]);
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = buildCss(settings.themeId, custom);
  applyBackgroundImage(custom, settings.themeId);
}

let listenersInstalled = false;

export async function run(): Promise<void> {
  await applyCurrent();
  if (listenersInstalled) return;
  listenersInstalled = true;
  onSettingsChanged(() => void applyCurrent());
  onCustomThemeChanged(() => void applyCurrent());
}
