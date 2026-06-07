import { getSettings, onSettingsChanged } from '@/storage/settingsStore';
import { getCustomTheme, onCustomThemeChanged } from '@/storage/themeStore';
import { getVideo } from '@/storage/videoStore';
import { CustomTheme } from '@/types';

const STYLE_ID = 'bloxplus-theme-style';
const PREVIEW_STYLE_ID = 'bloxplus-theme-preview';
const BG_OVERLAY_ID = 'bloxplus-theme-bg';
const CLASSIC_LOGO_URL = chrome.runtime.getURL('public/icons/classicroblox.png');

type ThemeVarKey = 'background' | 'nav' | 'text' | 'accent';

interface PresetTheme {
  id: string;
  name: string;
  vars?: Partial<Record<ThemeVarKey, string>>;
  bgImage?: string;
}

// `classic-2016` is intentionally dev-only: the inline conditional spread
// drops it from production bundles via Vite tree-shaking when
// `import.meta.env.DEV` is statically false. `npm run dev` keeps it; the
// `npm run build` (store) bundle excludes it from PRESETS entirely, so it
// disappears from the themes page UI AND from buildCss lookups (any leftover
// `themeId === 'classic-2016'` in user settings silently falls back because
// `PRESETS.find(...)` returns undefined → empty CSS → default styling).
const PRESETS: PresetTheme[] = [
  { id: 'default', name: 'Default' },
  {
    id: 'dark-blue',
    name: 'Dark blue',
    vars: {
      background: '#191e29',
      nav: '#06080f',
      text: '#ffffff',
      accent: '#ffffff',
    },
  },
  {
    id: 'forest',
    name: 'Forest',
    vars: {
      background: '#090a0b',
      nav: '#2b463d',
      text: '#ffffff',
      accent: '#ffffff',
    },
  },
  ...(import.meta.env.DEV
    ? [
        {
          id: 'classic-2016',
          name: 'Classic 2016',
          vars: {
            background: '#f4f4f4',
            nav: '#013a87',
            text: '#191919',
            accent: '#00a2ff',
          },
        } as PresetTheme,
      ]
    : []),
];

export function getPresets(): PresetTheme[] {
  return PRESETS;
}

function buildCss(themeId: string, custom: CustomTheme): string {
  const preset = PRESETS.find((p) => p.id === themeId);
  if (!preset && themeId !== 'custom') return '';

  const vars: Partial<Record<ThemeVarKey, string>> =
    themeId === 'custom'
      ? {
          background: custom.background,
          nav: custom.nav,
          text: custom.text,
          accent: custom.accent,
        }
      : preset?.vars ?? {};

  const cssVars = Object.entries(vars)
    .filter(([, v]) => !!v)
    .map(([k, v]) => `--bp-${k}: ${v};`)
    .join('\n      ');

  // We still need to emit the body.bp-has-bg-image override rules even when
  // the user's custom palette is empty (image-only theme). Only short-circuit
  // when there is genuinely nothing to apply — no palette vars AND no custom
  // image.
  if (!cssVars && !(themeId === 'custom' && custom.backgroundImage)) return '';

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
    /* When a custom background image is in use, both #wrap and body must let
       the image show through. #wrap is a normal-flow child of body, so its
       solid bg would otherwise paint over the z-index: -1 image overlay. */
    body.bp-has-bg-image.dark-theme,
    body.bp-has-bg-image.light-theme,
    body.bp-has-bg-image #wrap.wrap.no-gutter-ads,
    body.bp-has-bg-image #wrap {
      background-color: transparent !important;
    }
    /* Profile page: the .profile-avatar-left / .profile-avatar-gradient band
       at the top has its own solid bg + subtle gradient. Strip the solid
       layer so the user's photo shows behind the 3D avatar viewer. Use
       wildcard matches for "profile-avatar*", "profile-header*", "profile-
       banner*" to catch Roblox A/B layout variants too. */
    body.bp-has-bg-image [class*="profile-avatar"],
    body.bp-has-bg-image [class*="profile-header"],
    body.bp-has-bg-image [class*="profile-banner"],
    body.bp-has-bg-image .profile-avatar-left,
    body.bp-has-bg-image .profile-avatar-gradient,
    body.bp-has-bg-image .thumbnail-holder,
    body.bp-has-bg-image .avatar-thumbnail-container,
    body.bp-has-bg-image .cover-gradient-overlay {
      background-color: transparent !important;
      background-image: none !important;
    }
    /* Nav: Roblox top header bar, left navigation strip, footer links, and
       the chat panel — the full page chrome. Roblox swaps the left rail's and
       chat container's class names across builds, so target every variant we
       have seen plus broad attribute-contains fallbacks. */
    #header, .rbx-header, .navbar.rbx-header, nav.rbx-navbar,
    #navigation, .left-col, .rbx-left-col, .rbx-left-rail,
    #navbar-universal-search, .navbar-fixed-top,
    #left-rail, .left-rail, .scrollable-left-rail,
    nav#left-rail, nav.left-rail, nav#left-nav, .left-nav,
    [data-rbx-component="left-rail"], [class*="LeftRail" i],
    [class*="left-rail" i], aside.left-rail,
    /* Footer */
    #footer, .rbx-footer, footer.rbx-footer, footer.footer,
    .footer-container, [class*="Footer" i],
    /* Chat panel (Aurora + legacy) */
    #chat-container-aurora, #chrome-chat, .rbx-chat-container,
    .chrome-chat, .chat-container, [id*="chat-container" i],
    [class*="ChatContainer" i] {
      ${vars.nav ? `background-color: var(--bp-nav) !important;` : ''}
    }
    /* Accent on links + active states. */
    a, .link, .text-link, .text-name, .nav-menu-active a {
      ${vars.accent ? `color: var(--bp-accent) !important;` : ''}
    }
    .btn-primary, .btn-cta-md, .btn-control-md.btn-primary-md {
      ${vars.accent ? `background-color: var(--bp-accent) !important;` : ''}
      ${vars.accent ? `border-color: var(--bp-accent) !important;` : ''}
    }
    ${getEraLayoutCss(themeId)}

    /* Game-page tab content (About / Store / Servers) — tie the card
       background to the theme's nav/header color. When a custom background
       image is set we deliberately strip this bg so the image shows through. */
    ${
      vars.nav
        ? `
    .game-about-container,
    .game-description-container,
    .game-stat-container,
    .game-stats-container,
    #bloxplus-dev-products-section,
    #rbx-game-passes,
    .social-links .contents {
      background-color: var(--bp-nav);
      border-radius: 8px;
      padding: 10px 12px;
    }
    body.bp-has-bg-image .game-about-container,
    body.bp-has-bg-image .game-description-container,
    body.bp-has-bg-image .game-stat-container,
    body.bp-has-bg-image .game-stats-container,
    body.bp-has-bg-image #bloxplus-dev-products-section,
    body.bp-has-bg-image #rbx-game-passes,
    body.bp-has-bg-image .social-links .contents {
      background-color: transparent !important;
      padding: 0 !important;
      border-radius: 0 !important;
    }`
        : ''
    }

    /* Readability panels for SviBlox-rendered widgets only — when a photo
       background is set, give our own surfaces a translucent dark panel so
       the text stays legible. Roblox's own tab containers are intentionally
       NOT in this list; they are made transparent above so the photo shows. */
    body.bp-has-bg-image .bp-badge-row,
    body.bp-has-bg-image .bp-badges-summary,
    body.bp-has-bg-image .bp-badges-controls,
    body.bp-has-bg-image .badge-container,
    body.bp-has-bg-image .btr-badges-container > * {
      background-color: rgba(0, 0, 0, 0.55) !important;
      backdrop-filter: blur(8px) saturate(1.1);
      -webkit-backdrop-filter: blur(8px) saturate(1.1);
      border-radius: 8px;
      padding: 10px 12px;
      color: #fff !important;
    }
    /* Rarity-coded text on badge rows (.bp-rarity-easy / -medium / -hard /
       -insane / -impossible) is explicitly excluded here so the badge
       enhancer's per-tier colors keep their intent against the dark blur
       overlay above. */
    body.bp-has-bg-image .bp-badge-row *:not([class*="bp-rarity-"]),
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

/**
 * Optional layout overlay for `classic-*` presets. Captures the *feel* of
 * pre-2016 Roblox (square corners, narrow content width, smaller text, classic
 * link-blue) using a small set of original CSS rules. No external images, no
 * base64 assets, no verbatim copy from third-party userstyles — inspired by
 * the look but written fresh. Returns an empty string for non-classic themes.
 */
function getEraLayoutCss(themeId: string): string {
  if (!themeId.startsWith('classic-')) return '';
  return `
    /* Tighter type + classic link blue ------------------------------------ */
    body {
      font-size: 13px;
    }
    a, .text-link, .text-name, .game-card-name,
    .item-card-name, .game-creator a {
      color: #095fb5;
    }

    /* Square everything — pre-2017 Roblox had no rounded corners. */
    .game-card-container, .game-card-thumb-container, .game-card-thumb,
    .item-card-thumb-container, .item-card-thumb,
    .thumbnail-2d-container, .avatar-headshot, .avatar-headshot-xs,
    .avatar-headshot-sm, .avatar-headshot-md, .avatar-headshot-lg,
    .avatar-card-image, .badge-image, .friends-carousel-container,
    .stack, .container-list, .section,
    .btn-control-sm, .btn-control-md, .btn-control-lg,
    .btn-primary-md, .btn-primary-sm, .btn-secondary-md,
    .input-field, .rbx-tab, .rbx-tab-heading,
    /* SviBlox-injected sections look classic too. */
    #bloxplus-favorites-section, #bloxplus-mygames-section,
    #bloxplus-subplaces-section, #bloxplus-spent-section,
    #bloxplus-dev-products-section, #rbx-game-passes {
      border-radius: 0 !important;
    }

    /* Old-narrow main column. Modern Roblox is full-width; classic was
       centered around 970px. */
    #container-main, .container-main, #content, .content {
      max-width: 970px;
      margin-left: auto !important;
      margin-right: auto !important;
    }

    /* Smaller header chrome — the 2014 nav was 36–40px tall. */
    #header, .rbx-header, nav.rbx-navbar {
      min-height: 36px;
      max-height: 40px;
    }

    /* Classic stat row: muted gray labels, red player count. */
    .game-card-info .vote-percentage-label,
    .bp-fav-stats .vote-percentage-label {
      color: #888 !important;
      font-weight: 600;
    }
    .game-card-info .playing-counts-label,
    .bp-fav-stats .playing-counts-label {
      color: #c00 !important;
    }

    /* Subtle 1px hairline on tile + card surfaces. */
    .game-card-container, .item-card-container,
    .stack-row, .badge-container, .container-list {
      border: 1px solid rgba(0, 0, 0, 0.18) !important;
    }

    /* Classic Roblox CDN images. We only reference www.roblox.com/images/...
       paths (the most stable historically). Every rule below has a solid
       background-color fallback so a 404 doesn't break the look. */

    /* Header strip: faint horizontal gradient texture. The fallback uses
       the nav color so the bar stays consistent if the image is gone. */
    #header, .rbx-header, .navbar.rbx-header, nav.rbx-navbar {
      background-image: url(https://www.roblox.com/images/RevisedHeader/bg-rbx_header.png) !important;
      background-repeat: repeat-x !important;
      background-position: top center !important;
    }

    /* Sub-menu hover strip on the left rail. */
    .rbx-left-col li:hover {
      background-image: url(https://www.roblox.com/images/RevisedHeader/bg-sub_menu_hover.png) !important;
      background-repeat: repeat-x !important;
    }

    /* Standard white-panel surfaces — pre-2016 used a faint top-shading
       texture (standardBox_01_bkg.png) but that asset is now 404. We
       emulate the look with a CSS linear-gradient instead — no asset
       dependency, identical visual effect. */
    .game-main-content .game-calls-to-action,
    .rbx-tab-content, #games-switcher,
    .signup-container, .modal-content,
    /* SviBlox sections inherit the texture so they look era-correct. */
    #bloxplus-favorites-section, #bloxplus-mygames-section,
    #bloxplus-subplaces-section, #bloxplus-spent-section,
    #bloxplus-dev-products-section {
      background-image: linear-gradient(
        to bottom,
        rgba(255, 255, 255, 0.95) 0,
        rgba(255, 255, 255, 0.95) 18px,
        rgba(240, 240, 240, 1) 18px,
        rgba(248, 248, 248, 1) 100%
      ) !important;
      background-repeat: no-repeat !important;
      background-position: top center !important;
      border: 1px solid #aaa !important;
    }

    /* Robux price marker — classic small coin icon next to amounts.
       Falls back to the regular Robux glyph if the image is gone. */
    .text-robux:not(.group-card-access),
    .text-robux-tile, .text-robux-lg {
      background-image: url(https://www.roblox.com/images/Icons/img-robux.png) !important;
      background-repeat: no-repeat !important;
      background-position: 0 1px !important;
      padding-left: 20px !important;
      color: #060 !important;
      font-weight: 700 !important;
    }

    /* Classic Roblox wordmark — bundled classicroblox.png (transparent),
       declared as a web_accessible_resource so the content-script CSS
       can load it. Paint the wordmark on ONE element only — the
       innermost <a.navbar-brand>. Roblox's DOM nests header → navbar-
       header → navbar-brand all at the same coordinates; painting on
       every level visually clones the wordmark with a transparent PNG
       (the opaque JPG previously hid the duplicates by occluding them). */
    .navbar-brand a, #navbar-logo, a.navbar-brand {
      background-image: url("${CLASSIC_LOGO_URL}") !important;
      background-repeat: no-repeat !important;
      background-position: left center !important;
      background-size: contain !important;
      background-color: transparent !important;
      width: 130px !important;
      min-width: 130px !important;
      height: 36px !important;
      font-size: 0 !important;
      color: transparent !important;
      overflow: hidden !important;
      position: relative !important;
    }
    /* Outer header containers carry size but no logo paint. */
    .icon-logo, .rbx-navbar-header, .navbar-brand .icon-logo,
    .navbar-header {
      background-image: none !important;
    }
    .icon-logo > *, .navbar-brand .icon-logo > *,
    .navbar-brand a > *, a.navbar-brand > * {
      display: none !important;
    }
    .icon-logo::after, .navbar-brand .icon-logo::after, .navbar-brand a::after,
    #navbar-logo::after, a.navbar-brand::after {
      content: '' !important;
      display: none !important;
    }

    /* Left rail should be white with dark text — only the *top header*
       follows the nav colour. Override our earlier nav-bg rules for the
       left rail in classic mode. */
    #navigation, .left-col, .rbx-left-col, .rbx-left-rail,
    #left-rail, .left-rail, .scrollable-left-rail,
    nav#left-rail, nav.left-rail, nav#left-nav, .left-nav,
    [data-rbx-component="left-rail"], [class*="LeftRail" i],
    [class*="left-rail" i], aside.left-rail {
      background-color: #ffffff !important;
      color: #222 !important;
      border-right: 1px solid #d8d8d8 !important;
    }
    /* Left-rail links: dark text + classic blue on active/hover. */
    #navigation a, .left-col a, .rbx-left-col a, .rbx-left-rail a,
    #left-rail a, .left-rail a, [class*="LeftRail" i] a,
    [class*="left-rail" i] a {
      color: #222 !important;
    }
    #navigation a:hover, .left-col a:hover, .rbx-left-col a:hover,
    .rbx-left-rail a:hover, #left-rail a:hover, .left-rail a:hover,
    [class*="LeftRail" i] a:hover, [class*="left-rail" i] a:hover,
    #navigation .nav-menu-active a, .left-col .nav-menu-active a {
      color: #095fb5 !important;
      background-color: #f0f0f0 !important;
    }

    /* The big pillow-green Play button on game detail pages. */
    .btn-common-play-game-lg,
    .btn-common-play-game-lg:hover {
      background-image: url(https://www.roblox.com/images/cssspecific/rbx2/btn_play_54h.png) !important;
      background-repeat: no-repeat !important;
      background-color: #008000 !important;
      min-height: 54px !important;
      border: 0 !important;
    }
    .btn-common-play-game-lg:hover {
      background-position: 0 -54px !important;
    }

    /* Classic tab edges (slice-9 style PNGs around .rbx-tab). */
    .rbx-tab .rbx-tab-heading,
    .rbx-tab:hover .rbx-tab-heading {
      background-image: url(https://www.roblox.com/images/cssspecific/rbx2/tab_white_31h_t2.png) !important;
      background-repeat: no-repeat !important;
      background-position: right top !important;
    }
    .rbx-tab {
      background-image: url(https://www.roblox.com/images/cssspecific/rbx2/tab_white_31h_t1.png) !important;
      background-repeat: no-repeat !important;
      background-position: left top !important;
    }
    .rbx-tab:hover .rbx-tab-heading { background-position: right -31px !important; }
    .rbx-tab:hover { background-position: left -31px !important; }
    .rbx-tab.active { background-position: left -62px !important; }
    .rbx-tabs-horizontal .rbx-tab.active .rbx-tab-heading {
      background-position: right -62px !important;
    }

    /* "Section header" (black tab) on group + profile titles. */
    .profile-header .profile-header-content,
    .group-details .container-header,
    .configure-group .container-header {
      background-image: url(https://www.roblox.com/images/cssspecific/rbx2/tab_black_33h_t2.png) !important;
      background-repeat: no-repeat !important;
      background-position: right top !important;
      background-color: #2b2b2b;
      color: #fff !important;
    }

    /* Classic silver button tile — covers all secondary action buttons. */
    .btn-control-sm, .btn-secondary-md, .btn-control-xs,
    .btn-control-md, .btn-alert-md {
      background-image: url(https://www.roblox.com/images/UI/btn-big_silver_tile.png) !important;
      background-repeat: repeat-x !important;
      background-color: #d8d8d8 !important;
      border: 1px solid #9e9e9e !important;
      color: #000 !important;
    }
    .btn-control-sm:hover, .btn-secondary-md:hover,
    .btn-control-xs:hover, .btn-control-md:hover {
      background-position: 0 bottom !important;
    }

    /* Classic blue "More" / CTA gradient button. */
    .games-filter-changer.container-header .btn-more,
    .btn-cta-md, .btn-primary-md.btn-cta-md,
    #group-join-button {
      background-image: url(https://www.roblox.com/images/Buttons/StyleGuide/bg-btn-blue.png) !important;
      background-repeat: repeat-x !important;
      background-color: #0852b7 !important;
      border: 1px solid #0852b7 !important;
      color: #fff !important;
      background-position: left -96px !important;
    }
    .games-filter-changer.container-header .btn-more:hover,
    .btn-cta-md:hover, #group-join-button:hover {
      background-position: left -128px !important;
      text-decoration: none !important;
    }

    /* Favorite star sprite. */
    #rbx-body .icon-favorite {
      background-image: url(https://www.roblox.com/images/cssspecific/rbx2/favoriteStar_20h.png) !important;
      background-repeat: no-repeat !important;
      background-position: 0 -20px !important;
      width: 20px !important;
      height: 20px !important;
    }
    #rbx-body .icon-favorite.favorited,
    #rbx-body a:hover .icon-favorite {
      background-position: 0 0 !important;
    }

    /* Search icon in the navbar search field. */
    .rbx-header .navbar-search .input-addon-btn .icon-common-search-sm,
    .rbx-header .navbar-search .input-field .icon-common-search-sm {
      background-image: url(https://www.roblox.com/images/searchIcon.png) !important;
      background-repeat: no-repeat !important;
      background-position: 4px 2px !important;
    }

    /* Online/offline status dots on friend avatars (classic green/grey). */
    .people-list .avatar-container .avatar-status,
    .friends-content .avatar-card-fullbody .avatar-status {
      background-image: url(https://www.roblox.com/images/offline.png) !important;
      background-repeat: no-repeat !important;
      background-color: transparent !important;
      width: 9px !important;
      height: 9px !important;
    }
    .icon-game, .icon-online, .icon-studio,
    .people-list .avatar-container .avatar-status.icon-game,
    .people-list .avatar-container .avatar-status.icon-online {
      background-image: url(https://www.roblox.com/images/online.png) !important;
    }

    /* Classic vote thumb sprites in the voting panel. */
    .voting-panel .users-vote .upvote span,
    .voting-panel .users-vote .downvote span {
      background-image: url(https://www.roblox.com/images/Icons/thumbsup.png) !important;
      background-repeat: no-repeat !important;
      width: 12px !important;
      height: 13px !important;
    }
    .voting-panel .users-vote .upvote span { background-position: 0 -170px !important; }
    .voting-panel .users-vote .upvote span.selected { background-position: 0 -184px !important; }
    .voting-panel .users-vote .upvote span:hover { background-position: 0 -197px !important; }
    .voting-panel .users-vote .downvote span { background-position: 0 -224px !important; }
    .voting-panel .users-vote .downvote span.selected { background-position: 0 -238px !important; }
    .voting-panel .users-vote .downvote span:hover { background-position: 0 -252px !important; }

    /* Pager arrows on profile / inventory paging. */
    .pager-next a, .pager-next button,
    .btr-pager-next button {
      background-image: url(https://www.roblox.com/images/arrow_36px_right.png) !important;
      background-color: transparent !important;
    }
    .pager-prev a, .pager-prev button,
    .btr-pager-prev button {
      background-image: url(https://www.roblox.com/images/arrow_36px_left.png) !important;
      background-color: transparent !important;
    }
    .pager-next a:hover, .pager-next button:hover,
    .btr-pager-next button:hover {
      background-image: url(https://www.roblox.com/images/arrow36px_rightOn.png) !important;
    }
    .pager-prev a:hover, .pager-prev button:hover,
    .btr-pager-prev button:hover {
      background-image: url(https://www.roblox.com/images/arrow36px_leftOn.png) !important;
    }

    /* Footer strip — light grey band, classic look. */
    .container-footer {
      background-color: #e6e6e6 !important;
      padding: 0 0 2px 0 !important;
    }
    .container-footer a, .container-footer .text-footer-nav {
      color: #095fb5 !important;
    }

    /* Square the avatar headshots that classic Roblox never rounded. */
    .avatar-headshot, .avatar-headshot-xs, .avatar-headshot-sm,
    .avatar-headshot-md, .avatar-card-image,
    .avatar-card-fullbody .avatar-card-image,
    .avatar-card-fullbody .avatar-card-link {
      border-radius: 0 !important;
    }

    /* "Voted: 94%" prefix on game tile stats (classic Roblox always
       wrote out the word "Voted:" rather than just showing a percent). */
    .game-card-link .game-card-info .vote-percentage-label::before,
    .bp-fav-stats .vote-percentage-label::before {
      content: "Voted: ";
      opacity: 0.75;
    }

    /* "<n> players online" suffix on active-count labels. */
    .game-card-link .game-card-info .playing-counts-label::after,
    .bp-fav-stats .playing-counts-label::after {
      content: " players online";
      font-weight: 400;
      opacity: 0.85;
    }

    /* Hide the modern gray vote/playing pill icons next to the labels —
       classic stat rows were just text on grey. */
    .game-card-info .icon-votes-gray,
    .game-card-info .icon-playing-counts-gray,
    .bp-fav-stats .icon-votes-gray,
    .bp-fav-stats .icon-playing-counts-gray {
      display: none !important;
    }

    /* Verdana body text for description / about / comment surfaces. The old
       Roblox used Verdana for paragraph text and Arial for headings. */
    .game-about-container, .game-description-container,
    .text.game-description, .text.game-description.linkify,
    .btr-game-main-container .btr-description,
    .group-details .group-description,
    .group-details .group-shout .group-shout-body,
    .profile-about .profile-about-content .profile-about-content-text,
    .comments-container .comment-item,
    .comment.list-item, .friends-content .avatar-name {
      font-family: Verdana, Geneva, sans-serif !important;
      font-size: 11px !important;
      line-height: 1.5 !important;
    }

    /* Classic header navbar icon sprite — single sprite sheet for the
       messages / friends / robux / settings glyphs at top-right. */
    .icon-nav-friend-btr, .icon-nav-message-btr,
    #nav-robux-icon .icon-robux-28x28,
    #rbx-body .icon-nav-settings {
      background-image: url(https://www.roblox.com/images/RevisedHeader/bg-icon_sprites.png) !important;
      background-repeat: no-repeat !important;
      width: 20px !important;
      height: 20px !important;
      background-color: transparent !important;
    }
    .icon-nav-message-btr { background-position: 0 0 !important; }
    a:hover .icon-nav-message-btr { background-position: 0 -20px !important; }
    .icon-nav-friend-btr { background-position: 0 -40px !important; }
    a:hover .icon-nav-friend-btr { background-position: 0 -60px !important; }
    #nav-robux-icon .icon-robux-28x28 { background-position: 0 -80px !important; }
    #nav-robux-icon:hover .icon-robux-28x28 { background-position: 0 -100px !important; }
    #rbx-body .icon-nav-settings { background-position: 0 -160px !important; }

    /* Genre icon sprite next to "Genre: X" on game pages. */
    .text-name.item-genre {
      padding-left: 18px !important;
      position: relative;
    }
    .text-name.item-genre::before {
      content: "";
      display: inline-block;
      background-image: url(https://www.roblox.com/images/GenreIcons/GenreIconsSprite.png) !important;
      background-repeat: no-repeat !important;
      background-position: -48px 0 !important;
      width: 16px;
      height: 16px;
      position: absolute;
      left: 0;
    }

    /* Game cards: name in classic link blue with underline-on-hover, smaller
       creator caption in muted grey. */
    .game-card-link .game-card-name,
    .item-card-container .item-card-name {
      color: #095fb5 !important;
      font-weight: 700 !important;
      font-size: 12px !important;
      text-decoration: none !important;
    }
    .game-card-link:hover .game-card-name,
    .item-card-container:hover .item-card-name {
      text-decoration: underline !important;
    }
    .item-card-container .item-card-label,
    .item-card-container .creator-name {
      color: #666 !important;
      font-size: 11px !important;
    }

    /* Profile / community names get the classic uppercase-bold treatment. */
    .profile-header .header-caption .header-title .profile-name,
    .group-details .group-header .group-caption .group-name {
      text-transform: uppercase;
      letter-spacing: 0.02em;
      font-weight: 700 !important;
    }

    /* Footer link colors: classic blue links on the light-grey strip. */
    .container-footer .footer-links a,
    .container-footer .footer .text-footer-nav,
    .container-footer .text-link,
    .container-footer .text-name {
      color: #095fb5 !important;
    }

    /* "Created" / "Updated" labels on the game stats panel — older Roblox
       printed labels in grey with a colon. */
    .game-stat-container .text-label,
    .game-stats-container .text-label {
      color: #888 !important;
      font-size: 11px !important;
    }
    .game-stat-container .text-label::after,
    .game-stats-container .text-label::after {
      content: ":";
    }

    /* Force readable text colour inside the white-panel surfaces. Several
       classic palettes use white text (good against a blue body bg), but
       inside our white linear-gradient panels white-on-white disappears. */
    .game-about-container, .game-about-container *,
    .game-description-container, .game-description-container *,
    .game-stat-container, .game-stat-container *,
    .game-stats-container, .game-stats-container *,
    .game-main-content .game-calls-to-action,
    .game-main-content .game-calls-to-action *,
    .rbx-tab-content, .rbx-tab-content *,
    #games-switcher, #games-switcher *,
    .signup-container, .signup-container *,
    .modal-content, .modal-content *,
    #bloxplus-favorites-section, #bloxplus-favorites-section *,
    #bloxplus-mygames-section, #bloxplus-mygames-section *,
    #bloxplus-subplaces-section, #bloxplus-subplaces-section *,
    #bloxplus-spent-section, #bloxplus-spent-section *,
    #bloxplus-dev-products-section, #bloxplus-dev-products-section * {
      color: #222 !important;
    }
    /* Re-allow blue link colour inside those panels (would otherwise be
       overridden to #222 by the rule above). */
    .game-about-container a, .game-description-container a,
    .rbx-tab-content a, .game-calls-to-action a,
    #bloxplus-favorites-section a, #bloxplus-mygames-section a,
    #bloxplus-subplaces-section a, #bloxplus-spent-section a,
    #bloxplus-dev-products-section a,
    .game-card-link .game-card-name,
    .item-card-container .item-card-name,
    .game-creator a, .text-name {
      color: #095fb5 !important;
    }
    /* Player count keeps its red. */
    .playing-counts-label, .bp-fav-stats .playing-counts-label {
      color: #c00 !important;
    }

    /* Footer + chat panel: legible text on the dark nav-colour strip.
       Override the #095fb5 link colour we set elsewhere, only when on the
       nav-coloured surface (footer / chat header). */
    #footer, .rbx-footer, footer.rbx-footer, footer.footer,
    .footer-container, [class*="Footer" i] {
      color: rgba(255, 255, 255, 0.85) !important;
    }
    #footer a, .rbx-footer a, footer a,
    .footer-container a, [class*="Footer" i] a,
    #footer .text-footer-nav, .footer .text-footer-nav,
    #footer .text-link, .footer-container .text-link,
    #footer .text-name {
      color: rgba(255, 255, 255, 0.9) !important;
    }
    #footer a:hover, .rbx-footer a:hover, footer a:hover,
    .footer-container a:hover {
      color: #fff !important;
      text-decoration: underline !important;
    }

    /* ---------------------------------------------------------------
       Extended classic skin — adapted from the public "ROBLOX 2012" /
       "2014-esque Roblox" UserScripts (GPLv3). Stylus preprocessor logic
       and the script's jQuery DOM rewrites are intentionally excluded;
       only CSS rules are kept and trimmed for clarity. Heavy form /
       avatar-editor / configure-group reskins were also dropped to
       limit bundle size and blast radius.
       --------------------------------------------------------------- */

    /* Body + container base. */
    body { background: #fff !important; color: #000 !important; font-size: 12px !important; }
    .container-main, #container-main, .content { background: transparent !important; }
    .container-fluid { max-width: 970px; margin: 0 auto; }

    /* Header: pre-2015 navbar — 36px tall, white text, classic blue. */
    #rbx-body .rbx-header {
      height: 36px !important;
      min-height: 36px !important;
      border: 0 !important;
    }
    .rbx-header .rbx-navbar-header { width: 118px; padding: 0; }
    .nav > li > a:focus, .nav > li > a:hover,
    #navbar-stream .nav-robux-icon:hover, #navbar-settings:hover {
      background-image: url(https://www.roblox.com/images/RevisedHeader/bg-main_menu_hover.png) !important;
      background-position: 0 0 !important;
    }
    #rbx-body .font-header-2.nav-menu-title.text-header {
      font-family: 'Source Sans Pro', Arial, Helvetica, sans-serif !important;
      line-height: 20px;
      color: #fff !important;
      font-weight: 700 !important;
    }
    .rbx-header .navbar-search .input-addon-btn,
    .rbx-header .navbar-search .input-field,
    .rbx-header .navbar-search {
      border-radius: 0 !important;
      box-shadow: none;
      height: 22px;
      color: #888;
      font-size: 13px;
    }
    .rbx-header .navbar-search .input-field,
    .rbx-header .navbar-search { width: 160px; font-family: arial; }
    .rbx-header .navbar-search.navbar-search-open .dropdown-menu {
      border: 1px solid #777;
      background: #efefef;
      border-radius: 0;
      margin-top: 2px;
    }

    /* Notification / robux / settings icon pads. */
    #navbar-robux [aria-describedby="buy-robux-popover"] #nav-robux-icon {
      background: #efefef !important;
      border-radius: 0 !important;
      border: 1px solid #777 !important;
      padding: 5px 6px 4px 6px !important;
    }
    #navbar-settings.navbar-icon-item [aria-describedby="settings-popover"] {
      background: #efefef !important;
      border: 1px solid #777 !important;
      border-bottom: 0 !important;
    }
    .popover-content .dropdown-menu {
      border: 1px solid #777 !important;
      background: #EFEFEF !important;
      border-radius: 0 !important;
      box-shadow: none !important;
    }
    .popover-content .dropdown-menu li a,
    .popover-content .dropdown-menu li button {
      font-size: 13px !important;
      padding: 1px 6px !important;
      line-height: 23px !important;
      color: #000 !important;
    }
    .popover-content .dropdown-menu li a:hover,
    .popover-content .dropdown-menu li button:hover {
      background: #ddd !important;
    }

    /* Left rail: horizontal mini-bar (classic 2013 sub-menu). */
    .btr-no-hamburger .rbx-left-col {
      width: 100% !important;
      height: 24px !important;
      margin-top: -4px;
    }
    .rbx-left-col ul { padding: 0 5px; height: 24px; }
    .rbx-left-col li {
      margin: 0 !important;
      display: inline-block !important;
      top: -1px;
    }
    .rbx-left-col li:hover, #navbar-robux:hover #nav-robux-icon {
      background-image: url(https://www.roblox.com/images/RevisedHeader/bg-sub_menu_hover.png) !important;
      background-repeat: repeat-x !important;
    }
    .rbx-left-col li .text-nav .font-header-2 {
      font: normal 12px arial !important;
      padding: 4px 5px 5px 5px !important;
      line-height: 15px !important;
    }
    .left-col-list > .font-bold.small.text-nav { display: none; }
    .rbx-nav-sponsor { display: none; }
    #navigation > ul { display: none; }

    /* Friend list / home-page section spacing. */
    #HomeContainer #people-list-container {
      border: 1px solid;
      padding: 0 10px;
      min-width: 0;
    }
    .home-header { border: 1px solid; padding-bottom: 10px; }
    .home-userinfo-upsell-container a {
      font: 400 14px arial !important;
      color: #095fb5 !important;
      width: 150px;
      text-align: center;
    }
    .people-list .friend {
      width: auto;
      padding-right: 0;
    }
    .people-list .friend:first-child { padding-left: 22px; }

    /* Game tiles (classic plain text stats). */
    .game-card-link .game-card-name {
      display: inline-block !important;
      color: #095fb5 !important;
      font: bold 12px arial !important;
    }
    .game-card-link .game-card-name:hover { text-decoration: underline; }
    .game-card-info {
      display: flex !important;
      flex-direction: column !important;
      position: relative !important;
      margin: 0 !important;
    }

    /* Game detail page: classic banner-style header. */
    .btr-gamedetails.btr-hide-ads div.content,
    #game-detail-page {
      max-width: 920px;
      padding: 0;
    }
    .game-main-content .game-calls-to-action .game-name {
      font-size: 18px !important;
      font-family: Arial !important;
      font-weight: 700 !important;
      padding: 3px 12px !important;
    }
    .game-main-content .game-calls-to-action .game-creator a { color: #095fb5 !important; }
    .game-main-content .game-calls-to-action {
      border: 1px solid #aaa !important;
      margin-top: 10px;
      width: 900px;
      max-width: 100%;
      float: left;
      height: 100%;
      min-height: 406px;
    }
    .game-stats-container { padding: 8px 0 12px 10px !important; border: 0 !important; }
    .game-stat-width .text-label {
      color: #888 !important;
      font-size: 11px !important;
    }
    .game-stats-container .text-lead { font-size: 11px !important; }
    .text.game-description.linkify {
      color: #000 !important;
      font: normal 10.6px arial !important;
    }

    /* Vote bar — green / red horizontal percentage bar. */
    .vote-bar { position: relative; height: 20px; width: 138px; }
    #vote-container {
      width: 100px;
      background-color: #B8B8B8;
      height: 6px;
      margin-top: 6px;
    }
    .vote-bar:hover #vote-container { background-color: #E27676; }
    #myBar { width: 1%; background-color: #757575; height: 6px; }
    .vote-bar:hover #vote-container #myBar { background-color: #02b757; }
    .voting-panel .users-vote .vote-details .vote-container .vote-percentage {
      background: #52A846 !important;
      height: 5px !important;
    }
    .voting-panel .users-vote .vote-details .vote-container .vote-background {
      height: 5px !important;
      background: #CE645B !important;
    }

    /* Favorite / Follow row text colours. */
    .game-main-content.follow-button-enabled
      .favorite-follow-vote-share .game-favorite-button-container .icon-label,
    .game-main-content.follow-button-enabled
      .favorite-follow-vote-share .game-follow-button-container .icon-label {
      color: #095fb5 !important;
      font-size: 12px !important;
      font-family: Arial !important;
    }

    /* Tab content: classic top-shaded white panel. */
    .rbx-tab-content {
      top: -2px;
      margin-top: 0 !important;
      border: 1px solid #aaa !important;
      background: #fff !important;
    }

    /* Block / status pages (e.g. private inventory). */
    body#rbx-body .icon-blocked {
      height: 100% !important;
      padding: 0 !important;
      background-size: cover !important;
    }

    /* Pagers + scroller arrows (classic Roblox kept simple chevrons). */
    .games-list .scroller.next .arrow {
      background: url(https://www.roblox.com/images/RevisedHeader/bg-sub_menu_hover.png) no-repeat center;
    }
    .horizontal-scroller .scroller {
      background: #646464 !important;
      border: 0 !important;
      width: 55px !important;
      opacity: 0.7 !important;
      height: 150px !important;
    }
    .games-list:hover .scroller { background: #000 !important; }

    /* Catalog item card: tighter, classic info layout. */
    .item-card-container .item-card-name {
      font-weight: bold !important;
      max-height: 29px !important;
      overflow: hidden !important;
      font-size: 12px !important;
      color: #095fb5 !important;
      line-height: 1.2 !important;
    }
    .item-card-container .creator-name.text-link {
      color: #095fb5 !important;
      font-size: 11px !important;
    }
    .item-card-container .item-card-name:hover { text-decoration: underline; }

    /* Inventory item card hover effect / borders. */
    .light-theme .item-card-container .item-card-thumb-container { border: 1px solid; }
    .asset-thumb-container {
      border-radius: 0 !important;
      border-color: #000;
    }

    /* Group / profile tabs (the small white tabs at top of those pages). */
    .rbx-tab .rbx-tab-heading span { color: #333 !important; font-weight: bold !important; }
    .rbx-tab-content .section-content { background: none !important; }

    /* Modal headers: classic black-tab style. */
    .modal-dialog .modal-content .modal-header {
      height: 34px !important;
      padding: 0 !important;
      margin-left: 5px !important;
      width: calc(100% - 5px) !important;
      color: #fff !important;
    }
    .modal-dialog .modal-content .modal-header .modal-title h4 {
      font-size: 20px !important;
      font-family: Arial !important;
      font-weight: 700 !important;
      color: #fff !important;
      padding-top: 2px !important;
    }

    /* Friends grid: classic-tight avatar tiles. */
    .friends-content .avatar-card-container .avatar-card-content .avatar-card-caption .avatar-name {
      color: #095fb5 !important;
      max-width: 96px !important;
      font-size: 13px !important;
    }
    .avatar-card-container .avatar-card-content .avatar-card-caption .avatar-card-label,
    .avatar-card-container .avatar-card-content .avatar-card-caption .avatar-status-link {
      padding: 0 !important;
      text-align: center !important;
      font-size: 10px !important;
    }

    /* Chat panel: rounded-off classic gradient header. */
    .chat-main .chat-header, .dialog-container .dialog-header, .chat-windows-header {
      background: linear-gradient(#007FFD, #0062C3) !important;
      border: 1px solid #000 !important;
      border-radius: 3px 3px 0 0 !important;
      height: 19px !important;
    }
    .chat-main, .dialog-container {
      box-shadow: none !important;
      border-radius: 0 !important;
    }
    .chat-main .chat-body, .dialog-container .dialog-body {
      background: #F2F2F2 !important;
      border-left: 1px solid #A6A6A6 !important;
      border-right: 1px solid #A6A6A6 !important;
      border-bottom: 1px solid #DCDCDC !important;
    }

    /* "Buy Robux" big-style button on landing. */
    .robux-cell h4 {
      color: #095fb5 !important;
      cursor: pointer;
      font-size: 12px !important;
      font-weight: 400 !important;
    }
    .robux-cell h4:after { content: " ROBUX"; }
    .robux-cell h4:hover { text-decoration: underline; }
    ${import.meta.env.DEV && themeId === 'classic-2016' ? get2016OverlayCss() : ''}
  `;
}

/**
 * 2016-specific overrides. The shared classic-era CSS above leans heavily on
 * pre-2014 visuals (PNG gradient buttons, slice-9 tab sprites, top-shaded
 * white panels with header texture strips). By 2016 Roblox had already moved
 * to a flatter design: solid navy header, flat CTA buttons, plain white
 * panels with a 1px border, Source Sans Pro everywhere. These rules undo the
 * heavier era styling for `classic-2016` only. Written fresh — no upstream
 * copy. Square corners and the narrow 970px content column are kept because
 * those *are* still period-correct for 2016.
 */
function get2016OverlayCss(): string {
  return `
    /* Flat solid navy header — drop the older PNG gradient strip. The
       --bp-nav variable already paints the bar; we just kill the image. */
    #header, .rbx-header, .navbar.rbx-header, nav.rbx-navbar {
      background-image: none !important;
      box-shadow: 0 1px 0 rgba(0,0,0,0.12) !important;
      min-height: 50px !important;
      max-height: 56px !important;
    }
    /* 2016 nav text + icons sit on a darker bar — bump contrast to white. */
    #header a, .rbx-header a, nav.rbx-navbar a,
    #header .text-nav, .rbx-header .text-nav,
    #header .font-header-2, .rbx-header .font-header-2 {
      color: rgba(255,255,255,0.92) !important;
    }
    #header a:hover, .rbx-header a:hover, nav.rbx-navbar a:hover {
      color: #ffffff !important;
    }

    /* Source Sans Pro across body chrome — 2016 Roblox used it for nav,
       headings, and most UI text. Description text stays Verdana from the
       shared rules above (that part *did* survive into 2016). */
    body, .container-main, .rbx-tab, .rbx-tab-heading,
    .game-card-name, .item-card-name, .text-name,
    .btn-control-md, .btn-cta-md, .btn-primary-md, .btn-secondary-md {
      font-family: 'Source Sans Pro', 'Helvetica Neue', Arial, sans-serif !important;
    }

    /* Flat primary CTA: solid bright blue (the 2016 accent), no PNG. */
    .btn-cta-md, .btn-primary-md.btn-cta-md,
    .games-filter-changer.container-header .btn-more, #group-join-button,
    .btn-primary, .btn-control-md.btn-primary-md {
      background-image: none !important;
      background-color: var(--bp-accent, #00a2ff) !important;
      border: 1px solid var(--bp-accent, #00a2ff) !important;
      color: #ffffff !important;
      box-shadow: none !important;
    }
    .btn-cta-md:hover, .btn-primary-md.btn-cta-md:hover,
    #group-join-button:hover, .btn-primary:hover {
      background-color: #008fdb !important;
      border-color: #008fdb !important;
    }

    /* Flat secondary button: white tile with a 1px grey border, no silver
       PNG gradient. */
    .btn-control-sm, .btn-secondary-md, .btn-control-xs,
    .btn-control-md, .btn-alert-md {
      background-image: none !important;
      background-color: #ffffff !important;
      border: 1px solid #b8b8b8 !important;
      color: #2a2a2a !important;
      box-shadow: none !important;
    }
    .btn-control-sm:hover, .btn-secondary-md:hover,
    .btn-control-xs:hover, .btn-control-md:hover {
      background-color: #f4f4f4 !important;
      border-color: #9a9a9a !important;
    }

    /* Plain white tab content — no top-shaded gradient texture. */
    .game-main-content .game-calls-to-action,
    .rbx-tab-content, #games-switcher,
    .signup-container, .modal-content,
    #bloxplus-favorites-section, #bloxplus-mygames-section,
    #bloxplus-subplaces-section, #bloxplus-spent-section,
    #bloxplus-dev-products-section {
      background-image: none !important;
      background-color: #ffffff !important;
      border: 1px solid #d8d8d8 !important;
    }

    /* Flat tab strip: drop the slice-9 PNG sprites, use flat colours. */
    .rbx-tab, .rbx-tab .rbx-tab-heading,
    .rbx-tab:hover, .rbx-tab:hover .rbx-tab-heading,
    .rbx-tab.active, .rbx-tabs-horizontal .rbx-tab.active .rbx-tab-heading {
      background-image: none !important;
      background-color: #eaeaea !important;
      color: #2a2a2a !important;
    }
    .rbx-tab.active, .rbx-tabs-horizontal .rbx-tab.active .rbx-tab-heading {
      background-color: #ffffff !important;
      border-top: 2px solid var(--bp-accent, #00a2ff) !important;
      color: var(--bp-accent, #00a2ff) !important;
    }

    /* Flat green Play button — the 2016 in-game CTA. No PNG sprite. */
    .btn-common-play-game-lg,
    .btn-common-play-game-lg:hover {
      background-image: none !important;
      background-color: #21a64a !important;
      border: 1px solid #1a8a3d !important;
      color: #ffffff !important;
      box-shadow: 0 1px 0 rgba(0,0,0,0.08) inset !important;
    }
    .btn-common-play-game-lg:hover {
      background-color: #1e9a44 !important;
    }

    /* Game tile and item card hairline — soft grey, not the dark 18% black. */
    .game-card-container, .item-card-container,
    .stack-row, .badge-container, .container-list {
      border: 1px solid #d8d8d8 !important;
    }

    /* Left-rail items pick up the bright 2016 accent on hover instead of
       the old #f0f0f0 / #095fb5 pair. */
    #navigation .nav-menu-active a, .left-col .nav-menu-active a,
    .rbx-left-col li.active a {
      color: var(--bp-accent, #00a2ff) !important;
      background-color: #f4f4f4 !important;
      border-left: 3px solid var(--bp-accent, #00a2ff) !important;
    }

    /* Group / profile section headers — flat dark band, not the old
       slice-9 black-tab PNG. */
    .profile-header .profile-header-content,
    .group-details .container-header,
    .configure-group .container-header {
      background-image: none !important;
      background-color: #2a2a2a !important;
      color: #ffffff !important;
      padding: 6px 12px !important;
    }

    /* Robux pill: flat green text, no coin PNG (the icon URL was already
       inconsistent by 2016). */
    .text-robux:not(.group-card-access),
    .text-robux-tile, .text-robux-lg {
      background-image: none !important;
      padding-left: 0 !important;
      color: #2c8e3a !important;
      font-weight: 700 !important;
    }
    .text-robux:not(.group-card-access)::before {
      content: "R$";
      font-weight: 700;
      margin-right: 2px;
    }

    /* Footer: keep it on the navy nav-strip but use the brighter 2016 link
       accent on hover instead of plain underline-only. */
    .container-footer a:hover {
      color: var(--bp-accent, #00a2ff) !important;
    }

    /* ----------------------------------------------------------------
       Vertical left rail for 2016. The shared classic CSS above flattens
       the rail into a horizontal 24px mini-bar (2013 look). Restore a
       proper stacked sidebar: icon + label per row, white background,
       hover/active states tied to --bp-accent.
       ---------------------------------------------------------------- */
    .btr-no-hamburger .rbx-left-col,
    #navigation, .left-col, .rbx-left-col, .rbx-left-rail,
    #left-rail, .left-rail, .scrollable-left-rail,
    nav#left-rail, nav.left-rail, nav#left-nav, .left-nav,
    [data-rbx-component="left-rail"], [class*="LeftRail" i],
    [class*="left-rail" i], aside.left-rail {
      width: 200px !important;
      min-width: 200px !important;
      max-width: 200px !important;
      height: calc(100vh - 50px) !important;
      min-height: 0 !important;
      margin: 0 !important;
      padding: 6px 0 !important;
      background-color: #ffffff !important;
      border-right: 1px solid #d8d8d8 !important;
      box-sizing: border-box !important;
      display: block !important;
      position: fixed !important;
      top: 50px !important;
      left: 0 !important;
      bottom: 0 !important;
      z-index: 50 !important;
      overflow-y: auto !important;
      overflow-x: hidden !important;
    }
    .rbx-left-col ul,
    [class*="LeftRail" i] ul, [class*="left-rail" i] ul {
      display: flex !important;
      flex-direction: column !important;
      padding: 0 !important;
      margin: 0 !important;
      height: auto !important;
      list-style: none !important;
    }
    .rbx-left-col li,
    [class*="LeftRail" i] li, [class*="left-rail" i] li {
      display: block !important;
      width: 100% !important;
      margin: 0 !important;
      top: auto !important;
      background-image: none !important;
      border-bottom: 1px solid #f0f0f0 !important;
    }
    /* The link/row itself: icon left, label right, padded. */
    .rbx-left-col li a,
    .rbx-left-col li > .text-nav,
    [class*="LeftRail" i] li a, [class*="left-rail" i] li a {
      display: flex !important;
      align-items: center !important;
      gap: 12px !important;
      padding: 9px 14px !important;
      color: #2a2a2a !important;
      text-decoration: none !important;
      font-family: 'Source Sans Pro', 'Helvetica Neue', Arial, sans-serif !important;
      font-size: 14px !important;
      font-weight: 500 !important;
      line-height: 1 !important;
      background-image: none !important;
    }
    .rbx-left-col li .text-nav .font-header-2,
    .rbx-left-col li .text-nav {
      font: 500 14px 'Source Sans Pro', 'Helvetica Neue', Arial, sans-serif !important;
      padding: 0 !important;
      line-height: 1 !important;
      color: inherit !important;
    }
    /* Hover + active states. */
    .rbx-left-col li:hover,
    [class*="LeftRail" i] li:hover, [class*="left-rail" i] li:hover {
      background-image: none !important;
      background-color: #f5f7fa !important;
    }
    .rbx-left-col li:hover a,
    [class*="LeftRail" i] li:hover a {
      color: var(--bp-accent, #00a2ff) !important;
    }
    .rbx-left-col li.active,
    .rbx-left-col li.nav-menu-active,
    [class*="LeftRail" i] li.active {
      background-color: #eef6fd !important;
      box-shadow: inset 3px 0 0 var(--bp-accent, #00a2ff) !important;
    }
    .rbx-left-col li.active a,
    .rbx-left-col li.nav-menu-active a {
      color: var(--bp-accent, #00a2ff) !important;
    }
    /* Icon glyphs in the rail: small, monochrome dark, drop sprite sheets. */
    .rbx-left-col li a [class*="icon-nav"],
    .rbx-left-col li a .icon-nav,
    [class*="LeftRail" i] li a [class*="icon"] {
      background-image: none !important;
      width: 20px !important;
      height: 20px !important;
      flex: 0 0 20px !important;
      filter: none !important;
      opacity: 0.85 !important;
    }
    .rbx-left-col li:hover a [class*="icon-nav"],
    .rbx-left-col li.active a [class*="icon-nav"] {
      opacity: 1 !important;
    }
    /* Friend count / notification badge inside a rail item — round pill
       in the accent colour, right-aligned. */
    .rbx-left-col li .notification,
    .rbx-left-col li .notification-blue,
    .rbx-left-col li [class*="notification" i],
    [class*="LeftRail" i] li [class*="notification" i] {
      margin-left: auto !important;
      min-width: 22px !important;
      height: 18px !important;
      padding: 0 6px !important;
      border-radius: 9px !important;
      background-color: var(--bp-accent, #00a2ff) !important;
      color: #ffffff !important;
      font-size: 11px !important;
      font-weight: 700 !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      line-height: 1 !important;
    }
    /* "Upgrade Now" / upsell button at the top of the rail. */
    .rbx-left-col .home-userinfo-upsell-container,
    .rbx-left-col .upsell-container,
    .rbx-left-col [class*="upsell" i] {
      display: block !important;
      margin: 8px 12px 12px 12px !important;
      padding: 0 !important;
    }
    .rbx-left-col .home-userinfo-upsell-container a,
    .rbx-left-col .upsell-container a,
    .rbx-left-col [class*="upsell" i] a,
    .rbx-left-col [class*="upsell" i] button {
      display: block !important;
      width: auto !important;
      padding: 8px 12px !important;
      background-color: #2eb24c !important;
      color: #ffffff !important;
      font-family: 'Source Sans Pro', 'Helvetica Neue', Arial, sans-serif !important;
      font-size: 14px !important;
      font-weight: 700 !important;
      text-align: center !important;
      text-decoration: none !important;
      border: 0 !important;
      border-radius: 3px !important;
      text-transform: none !important;
    }
    .rbx-left-col .home-userinfo-upsell-container a:hover,
    .rbx-left-col .upsell-container a:hover {
      background-color: #28a043 !important;
      text-decoration: none !important;
    }
    /* Username/avatar area at the very top of the rail. */
    .rbx-left-col .nav-username,
    .rbx-left-col .navbar-username,
    .rbx-left-col [class*="username" i],
    .rbx-left-col .text-username {
      display: block !important;
      padding: 10px 14px 6px 14px !important;
      font-family: 'Source Sans Pro', 'Helvetica Neue', Arial, sans-serif !important;
      font-size: 16px !important;
      font-weight: 700 !important;
      color: #2a2a2a !important;
    }
    /* Header is fixed at top, full width; rail is fixed at left below the
       header. Padding on body is what reserves space for both — no need to
       pad inner wrappers (which compounded and squashed content). */
    body {
      padding-top: 50px !important;
      padding-left: 200px !important;
      box-sizing: border-box !important;
    }
    /* Re-show the rail's primary nav list (the broader classic CSS hides
       it with #navigation > ul { display: none }). */
    #navigation > ul, .rbx-left-col > ul {
      display: flex !important;
    }

    /* ----------------------------------------------------------------
       2016 header polish — flatter navy bar, classic square search,
       Robux pill on the right, simple bell/cog cluster. Written fresh,
       targeting current Roblox DOM. Logo replacement is already wired
       up by the shared era CSS text mark.
       ---------------------------------------------------------------- */

    /* Force the navy from --bp-nav to win against header sprite rules.
       Header is fixed full-width at top; we deliberately do NOT set
       display: flex on it, because Roblox's internal nav layout is not
       designed to be reflowed as flex items and forcing it collapses
       the nav links. */
    #header, .rbx-header, .navbar.rbx-header, nav.rbx-navbar {
      background-image: none !important;
      background-color: var(--bp-nav, #013a87) !important;
      height: 50px !important;
      min-height: 50px !important;
      max-height: 50px !important;
      border-bottom: 1px solid rgba(0,0,0,0.18) !important;
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      z-index: 100 !important;
    }
    /* Top-bar nav links: white, no underline, simple hover bg. */
    #header .nav > li > a,
    .rbx-header .nav > li > a,
    nav.rbx-navbar .nav > li > a,
    #header .nav-menu-title,
    .rbx-header .nav-menu-title {
      color: rgba(255,255,255,0.92) !important;
      font-family: 'Source Sans Pro', 'Helvetica Neue', Arial, sans-serif !important;
      font-size: 14px !important;
      font-weight: 500 !important;
      padding: 0 12px !important;
      line-height: 50px !important;
      height: 50px !important;
      background-image: none !important;
    }
    #header .nav > li > a:hover,
    .rbx-header .nav > li > a:hover,
    nav.rbx-navbar .nav > li > a:hover {
      color: #ffffff !important;
      background-color: rgba(255,255,255,0.08) !important;
      background-image: none !important;
    }

    /* Search: square white pill, grey placeholder, fixed width. */
    .rbx-header .navbar-search,
    .rbx-header .navbar-search .input-field,
    .rbx-header .navbar-search .input-addon-btn,
    .rbx-header .navbar-search input {
      background-color: #ffffff !important;
      color: #333333 !important;
      border: 0 !important;
      border-radius: 0 !important;
      height: 28px !important;
      box-shadow: none !important;
      font-family: 'Source Sans Pro', 'Helvetica Neue', Arial, sans-serif !important;
      font-size: 13px !important;
    }
    .rbx-header .navbar-search {
      width: 320px !important;
      margin: 0 12px !important;
      display: flex !important;
      align-items: center !important;
    }
    .rbx-header .navbar-search input::placeholder {
      color: #888 !important;
      font-style: normal !important;
    }
    .rbx-header .navbar-search .input-addon-btn {
      background-color: #ffffff !important;
      color: #555 !important;
      width: 30px !important;
      padding: 0 !important;
    }

    /* Right cluster: avatar, Robux pill, bell, cog. */
    #navbar-robux, #nav-robux-amount,
    .rbx-header .nav-robux-amount,
    .rbx-header [class*="robux" i][class*="amount" i] {
      color: #ffffff !important;
      font-family: 'Source Sans Pro', 'Helvetica Neue', Arial, sans-serif !important;
      font-size: 13px !important;
      font-weight: 700 !important;
      padding: 0 10px !important;
      line-height: 50px !important;
    }
    /* Drop the older PNG framing on the robux/settings hit-areas — keep
       a simple transparent box with a hover tint. */
    #navbar-robux [aria-describedby="buy-robux-popover"] #nav-robux-icon,
    #navbar-settings.navbar-icon-item [aria-describedby="settings-popover"],
    .rbx-header .navbar-icon-item,
    .rbx-header [class*="navbar-icon" i] {
      background-color: transparent !important;
      background-image: none !important;
      border: 0 !important;
      padding: 0 8px !important;
      height: 50px !important;
      display: inline-flex !important;
      align-items: center !important;
      color: #ffffff !important;
    }
    .rbx-header .navbar-icon-item:hover,
    .rbx-header [class*="navbar-icon" i]:hover {
      background-color: rgba(255,255,255,0.08) !important;
    }
    /* Notification badge (unread bell count) — small red pill, top-right. */
    .rbx-header .notification,
    .rbx-header [class*="notification" i]:not([class*="container" i]) {
      background-color: #e02020 !important;
      color: #ffffff !important;
      border-radius: 9px !important;
      font-size: 10px !important;
      font-weight: 700 !important;
      min-width: 16px !important;
      height: 16px !important;
      padding: 0 5px !important;
      line-height: 16px !important;
      text-align: center !important;
    }

    /* Logo: re-anchor the bundled PNG for the 50px header. Paint the
       wordmark only on the innermost <a> — outer header containers
       carry size only, never a background image, to avoid the PNG
       being painted multiple times stacked. */
    .icon-logo, .rbx-navbar-header, .navbar-brand .icon-logo {
      width: 110px !important;
      min-width: 110px !important;
      height: 40px !important;
      margin-right: 8px !important;
      background-image: none !important;
    }
    .navbar-brand a, #navbar-logo, a.navbar-brand {
      width: 110px !important;
      min-width: 110px !important;
      height: 40px !important;
      margin-right: 8px !important;
      background-image: url("${CLASSIC_LOGO_URL}") !important;
      background-repeat: no-repeat !important;
      background-position: left center !important;
      background-size: contain !important;
    }

    /* Body bg: the GPL'd section forces #fff; restore --bp-background
       so the 2016 light-grey body comes back. */
    body {
      background: var(--bp-background, #f4f4f4) !important;
      color: var(--bp-text, #191919) !important;
    }

    /* Modern Roblox Home compatibility pass: the current left nav uses
       Tailwind-style class names, so the older .rbx-left-col rules above miss
       much of the visible sidebar. This block pulls the active Home layout
       closer to the 2012 reference: 40px top bar, 174px grey rail, centered
       970px content. */
    #header, .rbx-header, .navbar.rbx-header, nav.rbx-navbar {
      height: 40px !important;
      min-height: 40px !important;
      max-height: 40px !important;
    }
    #header > .container-fluid,
    .rbx-header > .container-fluid {
      width: 100% !important;
      max-width: none !important;
      height: 40px !important;
      margin: 0 !important;
      padding: 0 8px !important;
      box-sizing: border-box !important;
    }
    .rbx-navbar-header, .navbar-header {
      left: auto !important;
      width: 132px !important;
      min-width: 132px !important;
      height: 40px !important;
      margin: 0 12px 0 4px !important;
      padding: 0 !important;
      background-image: none !important;
    }
    .navbar-brand a, #navbar-logo, a.navbar-brand {
      left: auto !important;
      width: 132px !important;
      min-width: 132px !important;
      height: 40px !important;
      margin: 0 12px 0 4px !important;
      padding: 0 !important;
      background-image: url("${CLASSIC_LOGO_URL}") !important;
      background-repeat: no-repeat !important;
      background-position: left center !important;
      background-size: contain !important;
    }
    .icon-logo::after, .navbar-brand .icon-logo::after, .navbar-brand a::after,
    #navbar-logo::after, a.navbar-brand::after {
      content: '' !important;
      display: none !important;
    }
    #header .nav,
    .rbx-header .nav {
      height: 40px !important;
      top: 0 !important;
      margin: 0 !important;
    }
    #header .nav > li,
    .rbx-header .nav > li,
    #header .nav > li > a,
    .rbx-header .nav > li > a,
    #header .nav-menu-title,
    .rbx-header .nav-menu-title {
      height: 40px !important;
      line-height: 40px !important;
      padding-top: 0 !important;
      padding-bottom: 0 !important;
      font-size: 14px !important;
    }
    #nav-charts-md-link,
    #nav-marketplace-md-link,
    #header-develop-md-link,
    .rbx-header .robux-menu-btn {
      font-size: 0 !important;
      color: transparent !important;
      overflow: hidden !important;
      position: relative !important;
      text-align: center !important;
      text-indent: -9999px !important;
      text-shadow: none !important;
    }
    #nav-charts-sm-link,
    #nav-marketplace-sm-link,
    #header-develop-sm-link {
      font-size: 0 !important;
      color: transparent !important;
      text-shadow: none !important;
    }
    #nav-charts-md-link::after {
      content: 'Games';
    }
    #nav-marketplace-md-link::after {
      content: 'Catalog';
    }
    #header-develop-md-link::after {
      content: 'Develop';
    }
    .rbx-header .robux-menu-btn::after {
      content: 'ROBUX';
    }
    #nav-charts-md-link::after,
    #nav-marketplace-md-link::after,
    #header-develop-md-link::after,
    .rbx-header .robux-menu-btn::after {
      color: #ffffff !important;
      display: block !important;
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: 14px !important;
      font-weight: 700 !important;
      height: 40px !important;
      line-height: 40px !important;
      position: absolute !important;
      inset: 0 !important;
      text-align: center !important;
      text-indent: 0 !important;
    }
    .rbx-header .navbar-search {
      height: 28px !important;
      top: 6px !important;
      margin-top: 0 !important;
      width: 380px !important;
    }
    .rbx-header .navbar-right,
    .rbx-header .rbx-navbar-right,
    .rbx-header .rbx-navbar-icon-group,
    .rbx-header .navbar-icon-item,
    .rbx-header [class*="navbar-icon" i],
    #navbar-robux,
    #navbar-settings {
      top: 0 !important;
      height: 40px !important;
      line-height: 40px !important;
    }
    .rbx-header .navbar-right,
    .rbx-header .rbx-navbar-right {
      margin-top: 0 !important;
      position: absolute !important;
      top: 0 !important;
      right: 8px !important;
      height: 40px !important;
    }
    .rbx-header .navbar-icon-item,
    .rbx-header [class*="navbar-icon" i] {
      padding-top: 0 !important;
      padding-bottom: 0 !important;
      align-items: center !important;
    }

    body {
      padding-top: 40px !important;
      padding-left: 174px !important;
    }
    #wrap.wrap.no-gutter-ads,
    #wrap.wrap.logged-in {
      margin-left: 0 !important;
      padding-left: 0 !important;
      left: auto !important;
    }
    .container-main,
    #container-main,
    .content-no-ads {
      margin-top: 46px !important;
      max-width: 970px !important;
    }
    @media (min-width: 1500px) {
      .container-main,
      #container-main,
      .content-no-ads {
        margin-left: 292px !important;
        margin-right: auto !important;
      }
    }

    .left-nav {
      width: 174px !important;
      min-width: 174px !important;
      max-width: 174px !important;
      top: 40px !important;
      height: calc(100vh - 40px) !important;
      background: #dfe1e5 !important;
      border-right: 1px solid #c8cbd1 !important;
      color: #333333 !important;
      z-index: 80 !important;
    }
    .left-nav > div,
    .left-nav nav,
    .left-nav ul {
      width: 174px !important;
      padding-left: 0 !important;
      padding-right: 0 !important;
      margin-left: 0 !important;
      margin-right: 0 !important;
      box-sizing: border-box !important;
    }
    .left-nav nav {
      padding-top: 0 !important;
    }
    .left-nav li,
    .left-nav li > a {
      width: 174px !important;
      max-width: 174px !important;
      border-radius: 0 !important;
      box-sizing: border-box !important;
    }
    .left-nav li > a {
      min-height: 35px !important;
      height: 35px !important;
      padding: 0 10px !important;
      gap: 10px !important;
      color: #333333 !important;
      background: transparent !important;
      font-size: 16px !important;
      font-weight: 400 !important;
      line-height: 35px !important;
    }
    .left-nav li > a:hover {
      background: #eceef1 !important;
      color: #111111 !important;
    }
    .left-nav li > a.bg-surface-300,
    .left-nav li > a[aria-current="page"] {
      background: #cfd2d8 !important;
      color: #111111 !important;
      box-shadow: none !important;
    }
    .left-nav li > a svg,
    .left-nav li > a [class*="icon" i] {
      width: 22px !important;
      height: 22px !important;
      color: #666666 !important;
      opacity: 1 !important;
    }
    .left-nav [class*="width-["],
    .left-nav [class*="padding-x-large"] {
      width: 174px !important;
    }
    .left-nav .text-title-large,
    .left-nav [class*="text-title"] {
      color: inherit !important;
      font-size: 16px !important;
      font-weight: 400 !important;
    }

    .home-sort-header-container,
    .home-sort-header-container *,
    .container-header.people-list-header,
    .game-home-page-container h2,
    #bloxplus-favorites-section h2,
    #bloxplus-mygames-section h2 {
      color: #111111 !important;
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: 16px !important;
      font-weight: 700 !important;
      line-height: 24px !important;
      text-shadow: none !important;
    }
    .home-sort-header-container [data-sdui-text="true"],
    .home-sort-header-container [data-testid="text-icon-row-text"],
    .home-sort-header-container .sdui-icon {
      color: #111111 !important;
      fill: #111111 !important;
      opacity: 1 !important;
    }
    .game-home-page-container h1 {
      color: #111111 !important;
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: 30px !important;
      line-height: 1.1 !important;
      margin-bottom: 26px !important;
    }
    #HomeContainer .container-header.bp-host {
      min-height: 124px !important;
    }
    #bloxplus-most-played {
      top: -10px !important;
      min-height: 0 !important;
      height: 78px !important;
      z-index: 2 !important;
    }
    #bloxplus-most-played .bp-widget-body,
    #bloxplus-most-played .bp-most-played-list,
    #bloxplus-most-played [class*="body" i] {
      min-height: 0 !important;
    }
    #bloxplus-most-played .bp-empty,
    #bloxplus-most-played [class*="empty" i] {
      margin-top: 6px !important;
    }
    .react-friends-carousel-container,
    .friend-carousel-container {
      margin-bottom: 6px !important;
    }
    .friends-carousel-tile,
    .friends-carousel-tile button,
    .friend-tile-content {
      border-radius: 0 !important;
    }
    .avatar-card-fullbody,
    .avatar-card-link,
    .avatar-card-image,
    .avatar-card-image img,
    .thumbnail-2d-container,
    .add-friends-icon-container {
      border-radius: 0 !important;
    }
    .add-friends-icon-container {
      background: #e7e7e7 !important;
      border: 1px solid #b8b8b8 !important;
      box-sizing: border-box !important;
    }
    .friend-request-badge {
      border-radius: 2px !important;
      height: 18px !important;
      min-height: 18px !important;
      padding: 0 5px !important;
      line-height: 18px !important;
    }
    .game-card-container,
    #bloxplus-favorites-section .bp-fav-tile,
    #bloxplus-mygames-section .bp-fav-tile {
      background: transparent !important;
      border: 0 !important;
      box-shadow: none !important;
    }
    #bloxplus-favorites-section,
    #bloxplus-mygames-section {
      background: transparent !important;
      border: 0 !important;
      box-shadow: none !important;
      margin-top: 10px !important;
      padding: 0 !important;
    }
    #bloxplus-favorites-section .bp-fav-header,
    #bloxplus-mygames-section .bp-fav-header {
      border: 0 !important;
      padding: 0 !important;
      margin-bottom: 10px !important;
    }
    #bloxplus-favorites-section .bp-fav-meta,
    #bloxplus-mygames-section .bp-fav-meta {
      color: #777777 !important;
      font-size: 12px !important;
      font-weight: 400 !important;
    }
    .game-card-container .game-card-thumb-container,
    .game-card-container .game-card-thumb,
    #bloxplus-favorites-section .bp-fav-tile img,
    #bloxplus-mygames-section .bp-fav-tile img {
      border: 0 !important;
      background-color: #d8d8d8 !important;
      border-radius: 0 !important;
    }
    .game-card-info {
      color: #777777 !important;
      font-size: 12px !important;
      line-height: 16px !important;
    }
    .game-card-info .vote-percentage-label,
    .game-card-info .playing-counts-label,
    .bp-fav-stats {
      color: #777777 !important;
      font-weight: 400 !important;
    }
    .rbx-header #navbar-stream,
    .rbx-header #navbar-settings,
    .rbx-header #navbar-robux,
    .rbx-header .navbar-icon-item {
      background: transparent !important;
      border-radius: 0 !important;
      min-width: 0 !important;
      width: auto !important;
    }
    .rbx-header #navbar-stream {
      width: 44px !important;
      padding: 0 4px !important;
    }
    .rbx-header #navbar-stream .notification,
    .rbx-header .notification-count,
    .rbx-header [class*="notification" i]:not(.navbar-icon-item):not(.notification-margins) {
      background-color: #e02020 !important;
      color: #ffffff !important;
      border-radius: 9px !important;
      min-width: 16px !important;
      height: 16px !important;
      padding: 0 5px !important;
      line-height: 16px !important;
      font-size: 10px !important;
    }
    .chat-main,
    .dialog-container {
      bottom: 0 !important;
      right: 6px !important;
      width: 280px !important;
      max-height: 34px !important;
      overflow: hidden !important;
      border: 1px solid #999999 !important;
      border-bottom: 0 !important;
      background: #f3f3f3 !important;
    }
    .chat-main .chat-header,
    .dialog-container .dialog-header,
    .chat-windows-header {
      height: 34px !important;
      min-height: 34px !important;
      line-height: 34px !important;
      background: #0074bd !important;
      color: #ffffff !important;
      border-radius: 0 !important;
    }
    .chat-main .chat-body,
    .dialog-container .dialog-body {
      display: none !important;
    }

    /* ----------------------------------------------------------------
       Pass 6 polish — 2012 friend-bar feel:
       - Collapse the empty "Your Most Played" widget so Friends sits up.
       - Shrink friend avatars + Add Friends so the row fits more tiles
         at a classic-y diameter.
       - Tighten Favorites/My Games rows toward a 5-col layout with
         small square thumbnails and Arial labels.
       - Make the bottom chat read like a 2012 friends strip: full-width
         dark bar with a left "Chat" title and right-side controls.
       - Quiet the header right cluster.
       ---------------------------------------------------------------- */

    /* Most Played: when the widget shows the empty-state, collapse it
       so the page does not waste 80px of vertical real estate. */
    #bloxplus-most-played:has(.bp-empty) {
      height: 0 !important;
      min-height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      overflow: hidden !important;
      border: 0 !important;
    }
    #HomeContainer .container-header.bp-host:has(#bloxplus-most-played .bp-empty) {
      min-height: 0 !important;
    }
    /* Without :has() in older Chromium, fall back to a tighter widget. */
    #bloxplus-most-played {
      height: auto !important;
      max-height: 78px !important;
    }
    #bloxplus-most-played .bp-empty {
      padding: 0 !important;
      margin: 0 !important;
      font-size: 0 !important;
      color: transparent !important;
      line-height: 0 !important;
    }

    /* Friends carousel: more 2012-ish tile diameters. The classic Home
       fit about 9 tiles across at this column width with small avatars
       and a tight gap. */
    .react-friends-carousel-container,
    .friend-carousel-container {
      padding: 0 !important;
      margin: 6px 0 12px 0 !important;
    }
    .friends-carousel-tile,
    .friends-carousel-tile > * {
      width: 76px !important;
      max-width: 76px !important;
    }
    .friends-carousel-tile button,
    .friend-tile-content {
      padding: 0 !important;
      width: 76px !important;
    }
    .friends-carousel-tile .avatar-card-fullbody,
    .friends-carousel-tile .avatar-card-image,
    .friends-carousel-tile .thumbnail-2d-container {
      width: 84px !important;
      height: 108px !important;
      max-width: 84px !important;
      max-height: 108px !important;
      overflow: hidden !important;
    }
    /* Modern fullbody renders place the character around the centre of a
       150x150 frame with lots of transparent surround. Use object-fit:
       cover for a centre crop, then transform: scale(1.5) to zoom in so
       the figure fills the visible 84x108 tile like the 2012 reference. */
    .friends-carousel-tile .thumbnail-2d-container img,
    .friends-carousel-tile .avatar-card-image img {
      width: 100% !important;
      height: 100% !important;
      max-width: 100% !important;
      max-height: 100% !important;
      object-fit: cover !important;
      object-position: center 35% !important;
      transform: scale(1.5) translateY(8%) !important;
      transform-origin: center center !important;
      margin: 0 !important;
      display: block !important;
    }
    .friends-carousel-tile,
    .friends-carousel-tile > *,
    .friends-carousel-tile button,
    .friend-tile-content {
      width: 84px !important;
      max-width: 84px !important;
    }
    /* Roblox lays out the friends carousel as flex space-between, which
       leaves ~27px gaps between tiles and produces only 8 visible. The
       2012 reference packs tiles tightly with ~6px gaps, so override
       to flex-start with a fixed gap. */
    .friends-carousel-list-container {
      justify-content: flex-start !important;
      gap: 4px !important;
    }
    /* Modern Roblox friend tiles use a transparent headshot (face on
       transparent bg). Without a backing, the page bg shows through and
       the tile reads as "empty grey." Give the thumb wrapper a uniform
       light bg so the avatar always sits on the same square. */
    .friends-carousel-tile .avatar-card-image,
    .friends-carousel-tile .thumbnail-2d-container {
      background-color: #e6e8eb !important;
      border: 1px solid #c5c8cd !important;
      box-sizing: border-box !important;
    }
    .friends-carousel-tile .avatar-card-link,
    .friends-carousel-tile [class*="avatar-card-caption"],
    .friends-carousel-tile [class*="display-name"],
    .friends-carousel-tile [class*="text-overflow"] {
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: 11px !important;
      font-weight: 400 !important;
      color: #333333 !important;
      max-width: 76px !important;
      line-height: 14px !important;
      margin-top: 2px !important;
    }
    .add-friends-icon-container {
      width: 66px !important;
      height: 66px !important;
      max-width: 66px !important;
      max-height: 66px !important;
      background: #e7e7e7 !important;
      border: 1px solid #b8b8b8 !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      box-sizing: border-box !important;
      position: relative !important;
    }
    /* The big "+" glyph in the Add Friends tile. */
    .add-friends-icon-container .add-friends-icon,
    .add-friends-icon-container [class*="icon-filled-plus"],
    .add-friends-icon-container svg {
      width: 28px !important;
      height: 28px !important;
      color: #4b9bdc !important;
      fill: #4b9bdc !important;
    }
    /* The pending friend-request count is a small red pill at the
       top-right of the tile — not the whole tile. */
    .add-friends-icon-container .friend-request-badge {
      position: absolute !important;
      top: -4px !important;
      right: -4px !important;
      width: auto !important;
      height: 18px !important;
      min-width: 18px !important;
      max-width: none !important;
      max-height: 18px !important;
      padding: 0 5px !important;
      border-radius: 9px !important;
      background-color: #e02020 !important;
      color: #ffffff !important;
      font-size: 11px !important;
      font-weight: 700 !important;
      line-height: 18px !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
    }
    .add-friends-icon-container .friend-request-badge > * {
      width: auto !important;
      height: auto !important;
      padding: 0 !important;
      color: #ffffff !important;
      font-size: 11px !important;
      line-height: 18px !important;
    }

    /* Favorites / My Games rows: classic five-up square thumbs, no card
       chrome, Arial labels in dark grey. */
    #bloxplus-favorites-section .bp-fav-row,
    #bloxplus-mygames-section .bp-fav-row {
      display: grid !important;
      grid-template-columns: repeat(5, 1fr) !important;
      grid-template-rows: auto !important;
      grid-auto-rows: 0 !important;
      grid-auto-flow: row !important;
      overflow: hidden !important;
      gap: 8px !important;
      padding: 0 !important;
      margin: 0 !important;
      list-style: none !important;
    }
    /* Bootstrap's .row helper attaches a clearfix ::before/::after with
       display:table, which takes the first grid cell and shifts every
       tile one column to the right. Suppress the pseudo so column 1
       is free for the first tile. */
    #bloxplus-favorites-section .bp-fav-row::before,
    #bloxplus-favorites-section .bp-fav-row::after,
    #bloxplus-mygames-section .bp-fav-row::before,
    #bloxplus-mygames-section .bp-fav-row::after {
      content: none !important;
      display: none !important;
    }
    /* Cap each row to the first 5 tiles so the 2012-style single row is
       preserved — the rest are hidden, matching the original "See all"
       behavior. */
    #bloxplus-favorites-section .bp-fav-row > li:nth-child(n+6),
    #bloxplus-mygames-section .bp-fav-row > li:nth-child(n+6) {
      display: none !important;
    }
    #bloxplus-favorites-section .bp-fav-tile,
    #bloxplus-mygames-section .bp-fav-tile {
      width: 100% !important;
      margin: 0 !important;
      padding: 0 !important;
      background: transparent !important;
      border: 0 !important;
      box-shadow: none !important;
    }
    #bloxplus-favorites-section .bp-fav-tile img,
    #bloxplus-mygames-section .bp-fav-tile img,
    #bloxplus-favorites-section .bp-fav-tile .game-card-thumb,
    #bloxplus-mygames-section .bp-fav-tile .game-card-thumb {
      width: 100% !important;
      aspect-ratio: 1 / 1 !important;
      height: auto !important;
      border-radius: 0 !important;
      border: 0 !important;
      background-color: #d8d8d8 !important;
      object-fit: cover !important;
    }
    /* Kill all transitions on Favorites / My Games tiles. Roblox's
       transitions and our overrides race on hover and cause the
       thumbnail to flicker rapidly between two paint states. The
       2012 reference has no hover animation, so dropping them is
       on-theme and removes the flicker. */
    #bloxplus-favorites-section .bp-fav-tile,
    #bloxplus-favorites-section .bp-fav-tile *,
    #bloxplus-mygames-section .bp-fav-tile,
    #bloxplus-mygames-section .bp-fav-tile * {
      transition: none !important;
      animation: none !important;
    }
    #bloxplus-favorites-section .bp-fav-tile:hover,
    #bloxplus-favorites-section .bp-fav-tile:hover *,
    #bloxplus-mygames-section .bp-fav-tile:hover,
    #bloxplus-mygames-section .bp-fav-tile:hover * {
      transition: none !important;
      animation: none !important;
      transform: none !important;
    }
    #bloxplus-favorites-section .bp-fav-tile .bp-fav-name,
    #bloxplus-mygames-section .bp-fav-tile .bp-fav-name,
    #bloxplus-favorites-section .bp-fav-tile .game-card-name,
    #bloxplus-mygames-section .bp-fav-tile .game-card-name {
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: 12px !important;
      font-weight: 700 !important;
      color: #2a2a2a !important;
      margin: 4px 0 0 0 !important;
      line-height: 14px !important;
      max-height: 28px !important;
      overflow: hidden !important;
    }
    #bloxplus-favorites-section .bp-fav-tile .bp-fav-stats,
    #bloxplus-mygames-section .bp-fav-tile .bp-fav-stats,
    #bloxplus-favorites-section .bp-fav-tile .bp-fav-creator,
    #bloxplus-mygames-section .bp-fav-tile .bp-fav-creator {
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: 11px !important;
      font-weight: 400 !important;
      color: #777777 !important;
      line-height: 14px !important;
    }
    /* Hide the right-side "See all" stub when it's anchor-disabled; the
       classic Home didn't surface it for these widgets. */
    #bloxplus-favorites-section .bp-fav-see-all[aria-disabled="true"],
    #bloxplus-mygames-section .bp-fav-see-all[aria-disabled="true"] {
      display: none !important;
    }
    #bloxplus-favorites-section .bp-fav-meta,
    #bloxplus-mygames-section .bp-fav-meta {
      font-family: Arial, Helvetica, sans-serif !important;
      color: #999999 !important;
      font-size: 11px !important;
    }

    /* Continue row card labels: classic Arial, dark name + grey stats. */
    .game-card-container .game-card-name,
    .game-card-container .text-overflow {
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: 12px !important;
      font-weight: 700 !important;
      color: #2a2a2a !important;
      line-height: 14px !important;
    }
    .game-card-container .vote-percentage-label,
    .game-card-container .playing-counts-label,
    .game-card-info .text-overflow {
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: 11px !important;
    }

    /* Bottom chat strip: span more of the page, dark blue header, single
       row. Keep it minimized but make it read like a 2012 friend bar. */
    .chat-main,
    .dialog-container {
      left: 174px !important;
      right: 0 !important;
      width: auto !important;
      max-width: none !important;
      /* Sit above the SviBlox classic friends bar (56px) so the two
         strips stack like the 2012 reference: friends-online below,
         chat tabs above. */
      bottom: 56px !important;
      max-height: 28px !important;
      border: 0 !important;
      border-top: 1px solid #555555 !important;
      background: #1d2c52 !important;
      box-shadow: 0 -1px 0 rgba(0,0,0,0.18) !important;
    }
    .chat-main .chat-header,
    .dialog-container .dialog-header,
    .chat-windows-header {
      height: 28px !important;
      min-height: 28px !important;
      line-height: 28px !important;
      padding: 0 12px !important;
      background: #1d2c52 !important;
      color: #ffffff !important;
      border-radius: 0 !important;
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: 12px !important;
      font-weight: 700 !important;
      letter-spacing: 0.2px !important;
    }
    .chat-main .chat-header *,
    .dialog-container .dialog-header *,
    .chat-windows-header * {
      color: #ffffff !important;
      fill: #ffffff !important;
    }
    /* Bottom padding holds room for both the SviBlox classic friends bar
       (56px) and the chat strip stacked on top of it (28px). */
    body {
      padding-bottom: 84px !important;
    }

    /* Header right cluster: line up username/avatar/Robux/bell/cog on the
       40px bar without the modern rounded pill chrome. */
    .rbx-header .navbar-right > *,
    .rbx-header .rbx-navbar-right > * {
      height: 40px !important;
      line-height: 40px !important;
      margin: 0 !important;
      vertical-align: middle !important;
    }
    .rbx-header #navbar-robux .text {
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: 13px !important;
      font-weight: 700 !important;
      color: #ffffff !important;
    }
    .rbx-header .navbar-icon-item .nav-menu-icon,
    .rbx-header .navbar-icon-item svg {
      width: 18px !important;
      height: 18px !important;
      color: #ffffff !important;
      fill: #ffffff !important;
    }
    /* User pill: small square avatar + name, no pill background. */
    .rbx-header [id*="navbar-username"],
    .rbx-header .navbar-user,
    .rbx-header [class*="navbar-user" i] {
      background: transparent !important;
      border-radius: 0 !important;
      padding: 0 8px !important;
      height: 40px !important;
      line-height: 40px !important;
      color: #ffffff !important;
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: 13px !important;
      font-weight: 400 !important;
    }
    .rbx-header [class*="navbar-user" i] img,
    .rbx-header [class*="navbar-user" i] .avatar,
    .rbx-header [class*="navbar-user" i] .avatar-card-image,
    .rbx-header [class*="navbar-user" i] .thumbnail-2d-container {
      width: 26px !important;
      height: 26px !important;
      border-radius: 0 !important;
      border: 1px solid rgba(255,255,255,0.35) !important;
      margin-right: 6px !important;
    }

    /* ----------------------------------------------------------------
       Pass 9 — chase the 2012 reference screenshot:
       - Header bumped 40 → 56px so the search field, nav links, and
         Robux/bell/cog cluster all have proper breathing room.
       - The right-side username + avatar pill is hidden (reference is
         R$ / bell / cog only).
       - Friend tile display name jumps to 13px blue link, status text
         to 11px grey, with a green presence dot in front of names that
         have a sublabel.
       - SviBlox auto-collapse for the Standout/Recommended group is
         visually overridden in classic-2016 so the section stays open
         like the reference, while the toggle button still works.
       - Avatar thumbnail at the top of the left rail is hidden so only
         the username text remains.
       ---------------------------------------------------------------- */
    #header, .rbx-header, .navbar.rbx-header, nav.rbx-navbar {
      height: 56px !important;
      min-height: 56px !important;
      max-height: 56px !important;
    }
    #header > .container-fluid,
    .rbx-header > .container-fluid {
      height: 56px !important;
    }
    .rbx-navbar-header, .navbar-header,
    .navbar-brand a, #navbar-logo, a.navbar-brand {
      height: 56px !important;
      width: 144px !important;
      min-width: 144px !important;
    }
    #header .nav,
    .rbx-header .nav,
    #header .nav > li,
    .rbx-header .nav > li,
    #header .nav > li > a,
    .rbx-header .nav > li > a,
    #header .nav-menu-title,
    .rbx-header .nav-menu-title {
      height: 56px !important;
      line-height: 56px !important;
      font-size: 16px !important;
    }
    #nav-charts-md-link::after,
    #nav-marketplace-md-link::after,
    #header-develop-md-link::after,
    .rbx-header .robux-menu-btn::after {
      height: 56px !important;
      line-height: 56px !important;
      font-size: 16px !important;
    }
    .rbx-header .navbar-search {
      height: 36px !important;
      top: 10px !important;
      width: 440px !important;
      border-radius: 0 !important;
    }
    .rbx-header .navbar-search input,
    .rbx-header .navbar-search .input-field {
      height: 36px !important;
      font-size: 14px !important;
    }
    .rbx-header .navbar-right,
    .rbx-header .rbx-navbar-right,
    .rbx-header .navbar-icon-item,
    .rbx-header [class*="navbar-icon" i],
    #navbar-robux, #navbar-settings, #navbar-stream {
      height: 56px !important;
      line-height: 56px !important;
    }
    body {
      padding-top: 56px !important;
    }
    .left-nav {
      top: 56px !important;
      height: calc(100vh - 56px) !important;
    }
    .container-main, #container-main, .content-no-ads {
      margin-top: 16px !important;
    }

    /* Header right cluster — match the 2012 reference exactly:
       order is profile avatar → notification bell → settings cog → R$
       (Robux value rightmost). Username text is hidden; only the small
       avatar headshot remains. */
    .rbx-header .age-bracket-label {
      display: inline-flex !important;
      align-items: center !important;
      height: 56px !important;
      padding: 0 6px !important;
      order: 1 !important;
    }
    .rbx-header .age-bracket-label a,
    .rbx-header .age-bracket-label .text-link {
      display: inline-flex !important;
      align-items: center !important;
      text-decoration: none !important;
    }
    .rbx-header .age-bracket-label .avatar,
    .rbx-header .age-bracket-label .thumbnail-2d-container,
    .rbx-header .age-bracket-label .avatar-headshot-xs,
    .rbx-header .age-bracket-label img {
      width: 32px !important;
      height: 32px !important;
      border-radius: 2px !important;
      border: 1px solid rgba(255,255,255,0.35) !important;
      background-color: #c5c8cd !important;
    }
    /* Hide the username text — reference shows only the avatar. */
    .rbx-header .age-bracket-label .text-overflow,
    .rbx-header .age-bracket-label-username,
    .rbx-header .age-bracket-label .font-caption-header {
      display: none !important;
    }
    /* Reorder the cluster: avatar(1) → bell(2) → cog(3) → R$(4). The
       parent ul.rbx-navbar-icon-group is already display: flex. */
    .rbx-header #navbar-stream {
      order: 2 !important;
    }
    .rbx-header #navbar-settings {
      order: 3 !important;
    }
    .rbx-header #navbar-robux {
      order: 4 !important;
      margin-left: auto !important;
    }
    /* Stretch the search bar a touch wider to match the reference and
       remove the residual blue right-arrow. */
    .rbx-header .navbar-search {
      width: 500px !important;
    }
    .rbx-header .navbar-search input.form-control,
    .rbx-header .navbar-search input.input-field {
      border-radius: 0 !important;
      box-shadow: none !important;
      border: 1px solid #b8b8b8 !important;
      padding-left: 10px !important;
      background-color: #ffffff !important;
    }
    .rbx-header .navbar-search .input-addon-btn,
    .rbx-header .navbar-search button[type="submit"] {
      background-color: #ffffff !important;
      border: 1px solid #b8b8b8 !important;
      border-left: 0 !important;
      color: #555555 !important;
      border-radius: 0 !important;
    }
    #navbar-robux, #navbar-robux .text, #navbar-robux .rbx-robux-balance,
    #navbar-robux #nav-robux-amount,
    .rbx-header [class*="robux-balance" i],
    .rbx-header .rbx-text-navbar-right {
      color: #ffffff !important;
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: 14px !important;
      font-weight: 700 !important;
      padding: 0 6px 0 4px !important;
    }
    #navbar-robux .icon-robux-28x28 {
      width: 18px !important;
      height: 18px !important;
      display: inline-block !important;
      vertical-align: middle !important;
    }

    /* Friend tile display name + status + green presence dot. */
    .friends-carousel-display-name {
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: 13px !important;
      font-weight: 400 !important;
      color: #245cab !important;
      line-height: 16px !important;
      max-width: 90px !important;
    }
    .friends-carousel-tile-experience,
    .friends-carousel-tile-sublabel,
    .friends-carousel-tile-sublabel * {
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: 11px !important;
      line-height: 14px !important;
      color: #6e6e6e !important;
      max-width: 90px !important;
    }
    .friends-carousel-tile-sublabel svg,
    .friends-carousel-tile-sublabel [class*="icon-platform"],
    .friends-carousel-tile-sublabel [class*="icon-presence"] {
      display: none !important;
    }
    .friends-carousel-tile-labels {
      position: relative !important;
      display: block !important;
      padding-left: 0 !important;
    }
    .friends-carousel-tile-labels:has(.friends-carousel-tile-sublabel)
      .friends-carousel-display-name::before {
      content: '';
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background-color: #1aac4a;
      margin-right: 4px;
      vertical-align: 1px;
    }

    /* The Standout/Recommended group collapse is owned by SviBlox's
       homeEnhancer (bloxplus-collapse-style). Don't fight it — the user
       needs to be able to click the toggle and have the section hide
       or show. Previously we forced display:block here for the classic
       theme, which blocked the toggle entirely. */

    /* ----------------------------------------------------------------
       Mobile reset for classic-2016.
       The 2012 reference is a desktop layout; on narrow viewports the
       fixed 174px rail and 56px header don't fit and Roblox's own
       responsive code already handles tablet/mobile cleanly. Below
       1024px we undo our positioning so the page is usable on phones.
       ---------------------------------------------------------------- */
    @media (max-width: 1023px) {
      body {
        padding-top: 0 !important;
        padding-left: 0 !important;
        padding-bottom: 0 !important;
      }
      #header, .rbx-header, .navbar.rbx-header, nav.rbx-navbar {
        position: static !important;
        height: auto !important;
        min-height: 0 !important;
        max-height: none !important;
      }
      #header > .container-fluid,
      .rbx-header > .container-fluid {
        height: auto !important;
      }
      #header .nav,
      .rbx-header .nav,
      #header .nav > li,
      .rbx-header .nav > li,
      #header .nav > li > a,
      .rbx-header .nav > li > a,
      #header .nav-menu-title,
      .rbx-header .nav-menu-title,
      .rbx-header .navbar-right,
      .rbx-header .rbx-navbar-right,
      .rbx-header .navbar-icon-item,
      #navbar-robux, #navbar-settings, #navbar-stream {
        height: auto !important;
        line-height: normal !important;
      }
      /* Mobile keeps Roblox's own short labels — drop the desktop
         text-indent + ::after rewrites that overlap on small screens. */
      #nav-charts-md-link,
      #nav-marketplace-md-link,
      #header-develop-md-link,
      .rbx-header .robux-menu-btn,
      #nav-charts-sm-link,
      #nav-marketplace-sm-link,
      #header-develop-sm-link {
        font-size: inherit !important;
        color: inherit !important;
        text-indent: 0 !important;
        text-shadow: inherit !important;
      }
      #nav-charts-md-link::after,
      #nav-marketplace-md-link::after,
      #header-develop-md-link::after,
      .rbx-header .robux-menu-btn::after {
        content: none !important;
        display: none !important;
      }
      .rbx-header .navbar-search {
        width: auto !important;
        height: auto !important;
        top: auto !important;
        margin: 0 !important;
      }
      /* Don't restyle the rail itself; Roblox's responsive code keeps
         it off-screen on mobile via visibility:hidden + transform. */
      .left-nav {
        background: transparent !important;
        border-right: 0 !important;
      }
      /* Override the desktop max-width: 970px / margin-left: auto on
         #container-main / #content / .content. Without this the home
         page collapses to 8px wide on a 414px viewport because the
         desktop centering math falls apart when the rail isn't there. */
      #container-main,
      .container-main,
      #content,
      .content,
      .content-no-ads {
        max-width: none !important;
        width: auto !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
        margin-top: 0 !important;
      }
      .container-main, #container-main, .content-no-ads {
        margin-left: 0 !important;
        margin-top: 0 !important;
        max-width: none !important;
      }
      .chat-main, .dialog-container {
        left: auto !important;
        right: 0 !important;
        bottom: 0 !important;
      }
      /* The custom friend bar only makes sense on desktop. */
      #bloxplus-classic-friends-bar {
        display: none !important;
      }
      /* The bundled wordmark is a fixed pixel image; skip it on mobile
         so Roblox's responsive logo can render. */
      .icon-logo, .rbx-navbar-header, .navbar-brand .icon-logo,
      .navbar-brand a, #navbar-logo, a.navbar-brand {
        background-image: none !important;
        width: auto !important;
        min-width: 0 !important;
      }
    }

    /* Hide modern-only left-rail items that aren't in the 2012 reference.
       Official Store renders as a <button> (no href) so we hide any LI
       containing a button except the one we inject ourselves. */
    .left-nav nav > ul > li:has(a[href*="/plus"]),
    .left-nav nav > ul > li:has(a[href*="/giftcards"]),
    .left-nav nav > ul > li:has(button):not(#bloxplus-classic-upgrade-now) {
      display: none !important;
    }

    /* Hide ONLY the avatar thumbnail at the top of the left rail.
       Earlier the selector a span:first-child was too greedy and
       also matched the text-truncate-end span (which is :first-child
       of its .flex parent), hiding the username text. */
    .left-nav nav > ul > li:first-child a > span:nth-child(2),
    .left-nav nav > ul > li:first-child a .thumbnail-2d-container,
    .left-nav nav > ul > li:first-child a .icon-regular-roblox-plus {
      display: none !important;
    }
    .left-nav nav > ul > li:first-child a {
      padding: 10px 12px !important;
      color: #333333 !important;
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: 14px !important;
      font-weight: 400 !important;
      background: transparent !important;
      border-bottom: 1px solid #eeeeee !important;
    }

    /* ----------------------------------------------------------------
       Pass 27 — full header rewrite per the 2012 reference. Specificity
       is bumped via #rbx-body (matches Roblox's own #rbx-body .rbx-header
       which beats plain class selectors at 1,1,0 vs 0,1,0). The single
       source of truth for header sizing, logo, nav, search, and right
       cluster lives in this block — earlier conflicting blocks are
       superseded by this one because it appears latest in the stylesheet.
       ---------------------------------------------------------------- */
    #rbx-body .rbx-header,
    #rbx-body #header,
    #rbx-body .navbar.rbx-header,
    #rbx-body nav.rbx-navbar {
      height: 56px !important;
      min-height: 56px !important;
      max-height: 56px !important;
      background-color: var(--bp-nav, #013a87) !important;
      background-image: none !important;
      border-bottom: 1px solid rgba(0,0,0,0.18) !important;
    }
    #rbx-body .rbx-header > .container-fluid {
      height: 56px !important;
      min-height: 56px !important;
      max-height: 56px !important;
      padding: 0 12px !important;
    }

    /* Logo — bundled transparent PNG. Stretched a touch taller than the
       natural aspect ratio so it reads more like the slightly-chunky
       2012 wordmark, and shifted slightly up to sit cleanly on the bar. */
    #rbx-body .navbar-brand,
    #rbx-body a.navbar-brand,
    #rbx-body #navbar-logo {
      width: 110px !important;
      min-width: 110px !important;
      height: 46px !important;
      margin: 5px 12px 0 0 !important;
      padding: 0 !important;
      background-image: url("${CLASSIC_LOGO_URL}") !important;
      background-repeat: no-repeat !important;
      background-position: left top !important;
      background-size: 110px 46px !important;
      font-size: 0 !important;
      color: transparent !important;
      overflow: hidden !important;
    }
    #rbx-body .rbx-navbar-header,
    #rbx-body .navbar-header,
    #rbx-body .navbar-brand .icon-logo,
    #rbx-body .icon-logo {
      background-image: none !important;
      height: 56px !important;
      width: auto !important;
      min-width: 0 !important;
    }
    #rbx-body .navbar-brand::after,
    #rbx-body .navbar-brand a::after,
    #rbx-body #navbar-logo::after,
    #rbx-body .icon-logo::after {
      content: none !important;
      display: none !important;
    }

    /* Top nav links — original Charts/Marketplace/Create/Robux text is
       hidden by pass 7's font-size:0 + text-indent so only the ::after
       Games/Catalog/Develop/ROBUX rewrites show. Pass 27 only sizes the
       container LIs and styles the ::after pseudos — do NOT override
       font-size on the original <a> elements or the hidden text leaks
       back through as a stray "Ro" artifact. */
    #rbx-body .rbx-header .nav,
    #rbx-body #header .nav {
      height: 56px !important;
      margin: 0 !important;
      padding: 0 !important;
      display: flex !important;
      align-items: center !important;
    }
    #rbx-body .rbx-header .nav > li,
    #rbx-body #header .nav > li {
      height: 56px !important;
      display: flex !important;
      align-items: center !important;
    }
    /* Roblox renders BOTH a _md_link and a _sm_link for each top-nav
       item (Charts/Marketplace/Create/Robux). The SM variants are
       meant for mobile and Bootstrap normally hides them on wide
       viewports. Our display:flex on .nav > li above bypasses that
       responsive hiding, so the SM links surface as a duplicate
       Charts/Marketplace/Create/RI strip at y=56 below the header.
       Explicitly hide the SM links and any LI containing one. */
    #rbx-body #nav-charts-sm-link,
    #rbx-body #nav-marketplace-sm-link,
    #rbx-body #header-develop-sm-link,
    #rbx-body .rbx-header .nav > li:has(#nav-charts-sm-link),
    #rbx-body .rbx-header .nav > li:has(#nav-marketplace-sm-link),
    #rbx-body .rbx-header .nav > li:has(#header-develop-sm-link) {
      display: none !important;
    }
    #rbx-body #nav-charts-md-link::after,
    #rbx-body #nav-marketplace-md-link::after,
    #rbx-body #header-develop-md-link::after,
    #rbx-body .rbx-header .robux-menu-btn::after {
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: 14px !important;
      font-weight: 700 !important;
      color: #ffffff !important;
      line-height: 56px !important;
      height: 56px !important;
      padding: 0 14px !important;
      letter-spacing: 0.2px !important;
    }
    /* Robux nav button has a deeper DOM than the other links:
       LI#navigation-robux-container > DIV > A.robux-menu-btn
       The wrapping DIV defaults to height 79 and pulls the <a> to
       y=-11, so the ROBUX ::after pseudo lands above the header bar
       and the visible width truncates to ~28px. Anchor the wrapping
       DIV and the <a> to fill the LI but DO NOT touch the LI's width
       — its width is set by the flex parent and forcing 100% steals
       space from the other nav items. */
    #rbx-body #navigation-robux-container {
      height: 56px !important;
      display: flex !important;
      align-items: center !important;
    }
    #rbx-body #navigation-robux-container > div {
      height: 56px !important;
      width: 100% !important;
      max-width: none !important;
      min-width: 0 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      padding: 0 !important;
      margin: 0 !important;
      overflow: visible !important;
      flex: 1 1 100% !important;
    }
    #rbx-body .rbx-header .robux-menu-btn {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 100% !important;
      height: 56px !important;
      max-width: none !important;
      min-width: 0 !important;
      padding: 0 !important;
      margin: 0 !important;
      top: 0 !important;
      vertical-align: middle !important;
      position: relative !important;
      overflow: hidden !important;
      text-align: center !important;
    }
    #rbx-body .rbx-header .robux-menu-btn::after {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 100% !important;
      text-align: center !important;
      padding: 0 !important;
    }
    /* Style only the .nav-menu-title spans for non-rewritten links. */
    #rbx-body .rbx-header .nav > li > a:not(#nav-charts-md-link):not(#nav-marketplace-md-link):not(#header-develop-md-link):not(.robux-menu-btn),
    #rbx-body .rbx-header .nav-menu-title {
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: 14px !important;
      font-weight: 700 !important;
      color: #ffffff !important;
      line-height: 56px !important;
      height: 56px !important;
      padding: 0 14px !important;
    }

    /* Search bar — flat white pill, 30px tall, magnifier on the right.
       Position: absolute pins it to the header bar to the right of the
       Develop nav link (which ends around x=641 with my pass 7 sizing)
       regardless of the Bootstrap col float behavior. */
    #rbx-body .rbx-header .navbar-search {
      position: absolute !important;
      left: 810px !important;
      top: 13px !important;
      width: 360px !important;
      height: 30px !important;
      margin: 0 !important;
      padding: 0 !important;
      background-color: transparent !important;
      border: 0 !important;
      box-shadow: none !important;
      display: flex !important;
      align-items: center !important;
      float: none !important;
    }
    #rbx-body .rbx-header .navbar-search .input-group,
    #rbx-body .rbx-header .navbar-search form,
    #rbx-body .rbx-header .navbar-search .form-has-feedback {
      width: 100% !important;
      height: 30px !important;
      margin: 0 !important;
      padding: 0 !important;
      background-color: transparent !important;
      border: 0 !important;
      display: flex !important;
      align-items: center !important;
    }
    #rbx-body .rbx-header .navbar-search input.form-control,
    #rbx-body .rbx-header .navbar-search input.input-field,
    #rbx-body .rbx-header .navbar-search input[type="search"] {
      flex: 1 1 auto !important;
      width: 100% !important;
      height: 30px !important;
      line-height: 30px !important;
      padding: 0 34px 0 12px !important;
      border: 1px solid #ffffff !important;
      border-radius: 2px !important;
      background-color: #ffffff !important;
      color: #333333 !important;
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: 13px !important;
      box-shadow: none !important;
      outline: none !important;
    }
    #rbx-body .rbx-header .navbar-search input::placeholder {
      color: #888888 !important;
      font-style: normal !important;
    }
    /* Magnifier button overlaps the right edge of the input. */
    #rbx-body .rbx-header .navbar-search .input-addon-btn,
    #rbx-body .rbx-header .navbar-search button[type="submit"] {
      position: absolute !important;
      right: 2px !important;
      top: 2px !important;
      width: 26px !important;
      height: 26px !important;
      padding: 0 !important;
      margin: 0 !important;
      background-color: transparent !important;
      border: 0 !important;
      color: #888888 !important;
      cursor: pointer !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
    }
    #rbx-body .rbx-header .navbar-search .input-addon-btn .icon-nav-search,
    #rbx-body .rbx-header .navbar-search button svg {
      width: 16px !important;
      height: 16px !important;
      color: #888888 !important;
      fill: #888888 !important;
    }

    /* Right cluster — hide profile picture + notification, robux value
       only (uses CSS-drawn R$ pseudo instead of Roblox's PNG sprite),
       then settings cog. Type selectors are included so this rule's
       specificity beats the earlier .nav > li { display: flex } rule
       (which is 2,1,1 because of the > li type). */
    #rbx-body .rbx-header div.age-bracket-label,
    #rbx-body .rbx-header li#navbar-stream {
      display: none !important;
    }
    #rbx-body .rbx-header ul.rbx-navbar-icon-group {
      height: 56px !important;
      display: flex !important;
      align-items: center !important;
      padding: 0 !important;
      margin: 0 !important;
      gap: 6px !important;
    }
    #rbx-body .rbx-header #navbar-robux {
      order: 1 !important;
      margin-left: auto !important;
      height: 56px !important;
      display: inline-flex !important;
      align-items: center !important;
      padding: 0 10px !important;
      background: transparent !important;
    }
    #rbx-body .rbx-header #navbar-settings {
      order: 2 !important;
      height: 56px !important;
      display: inline-flex !important;
      align-items: center !important;
      padding: 0 10px !important;
      background: transparent !important;
    }
    /* Robux icon: hide Roblox's sprite, draw a clean "R$" pseudo. */
    #rbx-body .rbx-header #navbar-robux .icon-robux-28x28 {
      background-image: none !important;
      width: auto !important;
      height: auto !important;
    }
    #rbx-body .rbx-header #navbar-robux .icon-robux-28x28::before {
      content: 'R$';
      display: inline-block;
      width: auto;
      height: auto;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 14px;
      font-weight: 700;
      color: #ffffff;
      margin-right: 4px;
    }
    #rbx-body .rbx-header #navbar-robux #nav-robux-amount,
    #rbx-body .rbx-header #navbar-robux .rbx-text-navbar-right {
      color: #ffffff !important;
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: 14px !important;
      font-weight: 700 !important;
      padding: 0 !important;
      line-height: 56px !important;
    }
    #rbx-body .rbx-header #navbar-settings .navbar-icon-item-image,
    #rbx-body .rbx-header #navbar-settings svg,
    #rbx-body .rbx-header #navbar-settings .icon-nav-setting {
      width: 18px !important;
      height: 18px !important;
      color: #ffffff !important;
      fill: #ffffff !important;
    }

    /* Upgrade Now button — green, smooth rounded edges, text centered.
       Need width: auto + box-sizing to override pass 7's
       .left-nav nav > ul > li > a { width: 174px !important }
       which would otherwise force the button to overflow its 174px
       parent by the 24px of horizontal margin. */
    body #bloxplus-classic-upgrade-now > a {
      background: #2eb24c !important;
      background-color: #2eb24c !important;
      border: 1px solid #1f8e3a !important;
      color: #ffffff !important;
      text-decoration: none !important;
      display: block !important;
      width: auto !important;
      max-width: none !important;
      margin: 8px 12px !important;
      padding: 7px 10px !important;
      box-sizing: border-box !important;
      font-family: Arial, Helvetica, sans-serif !important;
      font-size: 14px !important;
      font-weight: 700 !important;
      text-align: center !important;
      line-height: 18px !important;
      border-radius: 8px !important;
      box-shadow: 0 1px 0 rgba(0,0,0,0.10) inset !important;
    }
    body #bloxplus-classic-upgrade-now > a:hover {
      background: #28a043 !important;
      background-color: #28a043 !important;
    }

    /* Hide the "Add Friends" circular tile at the head of the Friends
       carousel — the 2012 reference doesn't show it. */
    .react-friends-carousel-container .friends-carousel-tile:has(.add-friends-icon-container),
    .friend-carousel-container .friends-carousel-tile:has(.add-friends-icon-container) {
      display: none !important;
    }

    /* Friend count badge in the rail — small + blue pill instead of the
       large grey container. */
    .left-nav nav a[href*="friend-requests"] .foundation-web-badge {
      background: #4a90e2 !important;
      background-color: #4a90e2 !important;
      color: #ffffff !important;
      min-width: 22px !important;
      width: auto !important;
      height: 16px !important;
      min-height: 16px !important;
      padding: 0 5px !important;
      border-radius: 8px !important;
      font-size: 11px !important;
      font-weight: 700 !important;
      line-height: 16px !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
    }
    .left-nav nav a[href*="friend-requests"] .foundation-web-badge > * {
      color: #ffffff !important;
      font-size: 11px !important;
      line-height: 16px !important;
      padding: 0 !important;
      margin: 0 !important;
    }
  `;
}

// ── Background overlay state (still image OR animated video) ───────────────
// The overlay is a single fixed `z-index:-1` div. A still background paints
// directly onto it via `background-image`; a video background appends a
// `<video>` child that fills it. Only one is active at a time.
let bgVideoEl: HTMLVideoElement | null = null;
let bgVideoUrl: string | null = null; // object URL currently assigned to the <video>
let bgVideoId: string | null = null; // IndexedDB id of the loaded video
let bgVideoSeq = 0; // invalidates in-flight async blob loads on swap/teardown
let bgVisibilityHooked = false;
let bgVolume = 0; // desired video audio volume 0–100 (0 = muted), from the active theme
let bgWindowBlurred = false; // browser window currently unfocused → force-mute
let bgWindowAudioHooked = false;
let bgGestureUnmuteHooked = false;
// Live preview overrides set by the Themes-page sliders while editing. When
// non-null they take precedence over the stored theme value, so a router-driven
// `applyCurrent()` (which reads stored values) can't clobber an in-progress drag.
// Cleared when the edit ends (`clearBackgroundPreviewOverrides`).
let previewBrightness: number | null = null;
let previewVolume: number | null = null;

function applyBackgroundImage(custom: CustomTheme, themeId: string): void {
  const isCustom = themeId === 'custom';
  const videoId = isCustom ? custom.backgroundVideoId : undefined;
  const imageUrl = isCustom ? custom.backgroundImage : undefined;
  const hasBg = !!(videoId || imageUrl);
  document.body.classList.toggle('bp-has-bg-image', hasBg);

  let bg = document.getElementById(BG_OVERLAY_ID);
  if (!hasBg) {
    teardownBgVideo();
    bg?.remove();
    return;
  }
  if (!bg) {
    bg = document.createElement('div');
    bg.id = BG_OVERLAY_ID;
    document.body.appendChild(bg);
  }
  const mode = custom.backgroundMode ?? 'cover';
  // Prefer the live preview overrides (active slider drag) over stored values
  // so a dispatch-driven re-apply doesn't snap brightness/volume back.
  const brightness = previewBrightness ?? clampBrightness(custom.backgroundBrightness);
  bgVolume = previewVolume ?? clampVolume(custom.backgroundVideoVolume);
  hookWindowAudio();

  // Shared container base: fixed full-viewport, behind page content, inert.
  // NOTE: no `overflow: hidden` and no default `filter` here — both can knock a
  // <video> off the GPU's zero-copy hardware-overlay plane and force per-frame
  // compositing (visible as dropped frames / low FPS, worst on non-Chromium
  // builds like Opera). Brightness is applied via `applyOverlayBrightness`,
  // which only reaches for a CSS filter when actually brightening (>100%).
  bg.style.position = 'fixed';
  bg.style.inset = '0';
  bg.style.zIndex = '-1';
  bg.style.pointerEvents = 'none';

  if (videoId) {
    applyBackgroundVideo(bg, videoId, imageUrl, mode);
  } else {
    teardownBgVideo();
    applyBackgroundStill(bg, imageUrl as string, mode);
  }
  applyOverlayBrightness(bg, brightness);
  // Covers the "same video already mounted" early-return path in
  // applyBackgroundVideo; the fresh-mount path syncs itself once the async blob
  // load finishes. syncVideoPlayback also pauses if the window is unfocused.
  syncVideoPlayback();
}

function clampVolume(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * Applies the desired audio state to the mounted background video. The video
 * is muted when the user's volume is 0 OR the browser window is unfocused, so
 * a wallpaper with sound never plays into the background while the user is in
 * another app. Safe to call when no video is mounted (no-op).
 */
function applyVideoAudio(): void {
  if (!bgVideoEl) return;
  // Use the live focus/visibility state, not just the cached blur flag, so a
  // stray apply while the window isn't actually focused can never unmute.
  const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : !bgWindowBlurred;
  bgVideoEl.volume = Math.max(0, Math.min(1, bgVolume / 100));
  bgVideoEl.muted = bgVolume <= 0 || bgWindowBlurred || !focused || document.hidden;
}

/**
 * Mutes the background video whenever the browser window loses focus (and
 * restores on focus). `visibilitychange` only fires on tab switches within the
 * browser — switching to a *different application* leaves the tab "visible",
 * so a window-level blur/focus hook is what catches "Opera is unfocused".
 */
function hookWindowAudio(): void {
  if (bgWindowAudioHooked) return;
  bgWindowAudioHooked = true;
  window.addEventListener('blur', () => {
    bgWindowBlurred = true;
    syncVideoPlayback(); // pause + mute while the window is unfocused
  });
  window.addEventListener('focus', () => {
    bgWindowBlurred = false;
    syncVideoPlayback();
  });
  // Initialize from the current focus state (page may load unfocused).
  bgWindowBlurred = typeof document.hasFocus === 'function' ? !document.hasFocus() : false;
}

/**
 * Browsers block unmuted autoplay without a user gesture, so a saved
 * volume > 0 can't take effect on a cold page load until the user interacts.
 * Re-apply the audio on the first gesture so the chosen volume kicks in.
 */
function hookFirstGestureUnmute(): void {
  if (bgGestureUnmuteHooked) return;
  bgGestureUnmuteHooked = true;
  // Only a real pointer interaction unblocks autoplay-with-sound. We must NOT
  // unmute on keydown: keyboard app-switch shortcuts (e.g. Ctrl+Alt+Tab) fire
  // keydown on the page *before* the window `blur` event lands, which would
  // unmute the audio right as the user is leaving the window — the reported
  // "sound starts when I Ctrl+Alt+Tab" bug.
  window.addEventListener('pointerdown', () => syncVideoPlayback(), { capture: true, passive: true });
}

/**
 * Applies background brightness WITHOUT ever setting a CSS `filter` on the
 * overlay. A filter forces the `<video>` off the GPU's zero-copy hardware-overlay
 * plane into per-frame compositing — a large FPS hit (worst on Opera) — and it's
 * binary, so even 101% pays the full cost. Brightness is approximated with a
 * translucent child that preserves the plane:
 *   - 100% (default) → child hidden (fastest; video stays on the overlay plane).
 *   - < 100% (darken) → translucent **black** `.bp-bg-dim` child.
 *   - > 100% (lighten) → translucent **white** `.bp-bg-dim` child (a wash rather
 *     than a true luminance boost, but it keeps the plane; brightening a
 *     wallpaper is rare and small).
 */
function applyOverlayBrightness(bg: HTMLElement, brightness: number): void {
  bg.style.filter = '';
  let dim = bg.querySelector<HTMLElement>('.bp-bg-dim');
  const delta = brightness - 100;
  if (!delta) {
    if (dim) dim.style.opacity = '0';
    return;
  }
  if (!dim) {
    dim = document.createElement('div');
    dim.className = 'bp-bg-dim';
    dim.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:1;';
    bg.appendChild(dim);
  }
  dim.style.background = delta < 0 ? '#000' : '#fff';
  dim.style.opacity = String(Math.min(1, Math.abs(delta) / 100));
}

/** Paints a still image directly onto the overlay container. */
function applyBackgroundStill(
  bg: HTMLElement,
  url: string,
  mode: 'cover' | 'contain' | 'tile'
): void {
  const repeat = mode === 'tile' ? 'repeat' : 'no-repeat';
  const size = mode === 'tile' ? 'auto' : mode;
  bg.style.backgroundImage = `url(${JSON.stringify(url)})`;
  bg.style.backgroundSize = size;
  bg.style.backgroundRepeat = repeat;
  bg.style.backgroundPosition = 'center center';
}

/**
 * Loads the video blob from IndexedDB and mounts a looping `<video>` inside the
 * overlay. The optional `posterUrl` (the theme's still `backgroundImage`) paints
 * on the container underneath so there's no blank flash before the blob loads.
 * Async-race-guarded by `bgVideoSeq` so rapid theme swaps never mount a stale
 * video. `tile` mode is not meaningful for video → treated as `cover`.
 */
function applyBackgroundVideo(
  bg: HTMLElement,
  videoId: string,
  posterUrl: string | undefined,
  mode: 'cover' | 'contain' | 'tile'
): void {
  const fit = mode === 'contain' ? 'contain' : 'cover';
  // Poster underneath the (possibly still-loading) video.
  bg.style.backgroundImage = posterUrl ? `url(${JSON.stringify(posterUrl)})` : '';
  bg.style.backgroundSize = fit;
  bg.style.backgroundRepeat = 'no-repeat';
  bg.style.backgroundPosition = 'center center';

  // Same video already mounted in this container → just refresh the fit.
  if (bgVideoId === videoId && bgVideoEl && bgVideoEl.parentElement === bg) {
    bgVideoEl.style.objectFit = fit;
    return;
  }

  teardownBgVideo();
  const seq = bgVideoSeq;
  void getVideo(videoId).then((blob) => {
    if (seq !== bgVideoSeq) return; // superseded by a newer apply/teardown
    if (!blob) return; // blob missing → poster (if any) stays as fallback
    const container = document.getElementById(BG_OVERLAY_ID);
    if (!container) return;
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    // The class lets teardown sweep up any stray/forgotten background video in
    // the document — a detached or unreferenced <video> keeps playing audio
    // until GC, so every one we create must be findable and killable.
    v.className = 'bp-bg-video';
    v.autoplay = true;
    v.loop = true;
    // Start muted so autoplay is always allowed; `applyVideoAudio` raises the
    // volume afterward if the user set one (and a gesture has unblocked audio).
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('aria-hidden', 'true');
    v.src = url;
    v.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:${fit};z-index:0;`;
    container.appendChild(v);
    bgVideoEl = v;
    bgVideoUrl = url;
    bgVideoId = videoId;
    hookVisibilityPause();
    hookWindowAudio();
    hookFirstGestureUnmute();
    syncVideoPlayback();
  });
}

/**
 * Fully stops and releases a video element. `pause()` + `removeAttribute('src')`
 * alone is NOT enough on some Chromium builds (Opera especially) — the element
 * can keep playing the already-buffered media; `load()` aborts that and frees
 * the resource. Always run this before dropping a reference to a video we made.
 */
function killVideoEl(v: HTMLVideoElement): void {
  try {
    v.pause();
  } catch {
    /* ignore */
  }
  try {
    v.muted = true;
  } catch {
    /* ignore */
  }
  v.removeAttribute('src');
  try {
    v.load();
  } catch {
    /* ignore */
  }
  v.remove();
}

/**
 * Plays or pauses the background video to match the current focus/visibility,
 * then applies the audio (volume/mute) state. Pausing — not just muting — on
 * blur/hidden guarantees no sound leaks into the background even if a mute race
 * loses, and saves GPU while the window is away.
 */
function syncVideoPlayback(): void {
  if (!bgVideoEl) return;
  const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : !bgWindowBlurred;
  if (document.hidden || bgWindowBlurred || !focused) {
    try {
      bgVideoEl.pause();
    } catch {
      /* ignore */
    }
  } else {
    void bgVideoEl.play().catch(() => {});
  }
  applyVideoAudio();
}

/** Removes any mounted background video and invalidates in-flight blob loads. */
function teardownBgVideo(): void {
  bgVideoSeq++;
  // Kill the tracked element AND any stray `bp-bg-video` still in the document
  // (defends against an orphan left by a race or external DOM mutation — those
  // keep playing audibly otherwise, surviving theme switches).
  document.querySelectorAll<HTMLVideoElement>('video.bp-bg-video').forEach((v) => {
    if (v !== bgVideoEl) killVideoEl(v);
  });
  if (bgVideoEl) {
    killVideoEl(bgVideoEl);
    bgVideoEl = null;
  }
  if (bgVideoUrl) {
    URL.revokeObjectURL(bgVideoUrl);
    bgVideoUrl = null;
  }
  bgVideoId = null;
}

/** Pauses the background video on hidden tabs so it doesn't burn GPU/battery. */
function hookVisibilityPause(): void {
  if (bgVisibilityHooked) return;
  bgVisibilityHooked = true;
  document.addEventListener('visibilitychange', () => syncVideoPlayback());
}

function clampBrightness(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 100;
  return Math.max(0, Math.min(200, Math.round(v)));
}

/**
 * Live-update the overlay brightness without writing to storage or rebuilding
 * the theme stylesheet. Used by the Themes-page slider for frame-rate-friendly
 * dragging; commit to storage on mouseup separately. Routes through
 * `applyOverlayBrightness` so the video keeps its hardware-overlay fast path.
 */
export function setBackgroundBrightnessPreview(brightness: number): void {
  previewBrightness = clampBrightness(brightness);
  const bg = document.getElementById(BG_OVERLAY_ID);
  if (!bg) return;
  applyOverlayBrightness(bg, previewBrightness);
}

/**
 * Live-update the background-video audio volume from the Themes-page slider.
 * Because the slider drag is a user gesture, raising the volume here can
 * unmute even on browsers that block unmuted autoplay. Commit to storage on
 * Apply separately. No-op when no video is mounted.
 */
export function setBackgroundVolumePreview(volume: number): void {
  previewVolume = clampVolume(volume);
  bgVolume = previewVolume;
  applyVideoAudio();
}

/**
 * Clears the live brightness/volume preview overrides so subsequent
 * `applyCurrent()` calls fall back to the stored theme values. The Themes page
 * calls this when an edit ends (Apply / Discard / preset switch / overlay
 * close) — otherwise a stale override would leak into other themes.
 */
export function clearBackgroundPreviewOverrides(): void {
  previewBrightness = null;
  previewVolume = null;
}

/* ------------------------------------------------------------------ */
/* classic-2016 DOM tweaks                                              */
/* These run in addition to the CSS overlay and close visual gaps that  */
/* CSS alone can't reach: modern Roblox renders friend tiles as          */
/* transparent headshots (face only), the left rail no longer has an     */
/* "Upgrade Now" upsell, and Recommended For You sits below Favorites    */
/* instead of right after Continue.                                     */
/* ------------------------------------------------------------------ */

const CLASSIC_UPGRADE_ID = 'bloxplus-classic-upgrade-now';
const CLASSIC_AVATAR_FLAG = 'bpClassicFullbody';

function rewriteFriendAvatarsToFullbody(root: ParentNode = document): void {
  const imgs = root.querySelectorAll<HTMLImageElement>(
    '.friends-carousel-tile img[src*="AvatarHeadshot"]'
  );
  imgs.forEach((img) => {
    if (img.dataset[CLASSIC_AVATAR_FLAG] === '1') return;
    const src = img.getAttribute('src');
    if (!src) return;
    const fullbody = src
      .replace('-AvatarHeadshot-', '-Avatar-')
      .replace('/AvatarHeadshot/', '/Avatar/');
    if (fullbody === src) return;
    img.dataset[CLASSIC_AVATAR_FLAG] = '1';
    img.dataset.bpClassicOriginal = src;
    img.src = fullbody;
  });
}

function restoreFriendAvatars(root: ParentNode = document): void {
  const imgs = root.querySelectorAll<HTMLImageElement>(
    `.friends-carousel-tile img[data-bp-classic-fullbody="1"]`
  );
  imgs.forEach((img) => {
    const original = img.dataset.bpClassicOriginal;
    if (original) img.src = original;
    delete img.dataset[CLASSIC_AVATAR_FLAG];
    delete img.dataset.bpClassicOriginal;
  });
}

/**
 * Bring the left rail closer to the 2012 reference: hide the modern-only
 * items (Roblox Plus, Buy Gift Cards) and rename Avatar → Character,
 * Communities → Groups. Idempotent on each call. The label SPAN keeps a
 * `data-bp-classic-original` attribute so the rail can be reverted when
 * the theme is switched away.
 */
function ensureClassicLeftRailLabels(): void {
  const renameMap: Array<{ hrefIncludes: string; label: string }> = [
    { hrefIncludes: '/my/avatar', label: 'Character' },
    { hrefIncludes: '/communities', label: 'Groups' },
  ];
  for (const { hrefIncludes, label } of renameMap) {
    const link = document.querySelector<HTMLAnchorElement>(
      `.left-nav nav a[href*="${hrefIncludes}"]`
    );
    const span = link?.querySelector<HTMLSpanElement>('span.text-truncate-end.text-no-wrap');
    if (!span) continue;
    if (span.dataset.bpClassicOriginal === undefined) {
      span.dataset.bpClassicOriginal = span.textContent ?? '';
    }
    if (span.textContent !== label) span.textContent = label;
  }
}

function restoreLeftRailLabels(): void {
  const spans = document.querySelectorAll<HTMLSpanElement>(
    '.left-nav nav span.text-truncate-end.text-no-wrap[data-bp-classic-original]'
  );
  spans.forEach((s) => {
    if (s.dataset.bpClassicOriginal !== undefined) {
      s.textContent = s.dataset.bpClassicOriginal;
      delete s.dataset.bpClassicOriginal;
    }
  });
}

function ensureUpgradeNowButton(): void {
  if (document.getElementById(CLASSIC_UPGRADE_ID)) return;
  const navList = document.querySelector<HTMLUListElement>('.left-nav nav > ul');
  if (!navList) return;
  const li = document.createElement('li');
  li.id = CLASSIC_UPGRADE_ID;
  const a = document.createElement('a');
  a.href = 'https://www.roblox.com/premium/membership';
  a.textContent = 'Upgrade Now';
  a.style.cssText = [
    'display: block',
    'margin: 8px 12px',
    'padding: 7px 10px',
    'background: #2eb24c',
    'border: 1px solid #1f8e3a',
    "font-family: Arial, Helvetica, sans-serif",
    'font-size: 14px',
    'font-weight: 700',
    'color: #ffffff',
    'text-align: center',
    'text-decoration: none',
    'border-radius: 2px',
    'box-shadow: 0 1px 0 rgba(0,0,0,0.08) inset',
  ].join(';');
  a.addEventListener('mouseenter', () => {
    a.style.background = '#28a043';
  });
  a.addEventListener('mouseleave', () => {
    a.style.background = '#2eb24c';
  });
  li.appendChild(a);
  // Insert as the second item, after the username row.
  const first = navList.firstElementChild;
  if (first && first.nextSibling) {
    navList.insertBefore(li, first.nextSibling);
  } else {
    navList.appendChild(li);
  }
}

function removeUpgradeNowButton(): void {
  document.getElementById(CLASSIC_UPGRADE_ID)?.remove();
}

// Section reorder is owned by homeEnhancer.rearrangeHomeSections, which
// is aware of settings.themeId === 'classic-2016' and places Recommended
// right after Continue. We previously ran a parallel reorder here, but
// that fought homeEnhancer on every mutation and caused Recommended /
// Favorites to swap positions repeatedly.

/* ------------------------------------------------------------------ */
/* Bottom friends-online bar — the iconic 2012 detail at the bottom of  */
/* the Home page. Fetches the user's friends + presence + thumbnails    */
/* and renders a fixed strip with avatar chips.                         */
/* ------------------------------------------------------------------ */

const FRIENDS_BAR_ID = 'bloxplus-classic-friends-bar';
const FRIENDS_BAR_TTL_MS = 60_000;

interface ClassicFriend {
  id: number;
  name: string;
  online: boolean;
  inGame: boolean;
  thumb?: string;
}

interface ClassicFriendsCache {
  fetchedAt: number;
  friends: ClassicFriend[];
}

let friendsBarCache: ClassicFriendsCache | null = null;
let friendsBarInflight: Promise<ClassicFriend[]> | null = null;

async function fetchClassicFriends(): Promise<ClassicFriend[]> {
  if (friendsBarCache && Date.now() - friendsBarCache.fetchedAt < FRIENDS_BAR_TTL_MS) {
    return friendsBarCache.friends;
  }
  if (friendsBarInflight) return friendsBarInflight;
  friendsBarInflight = (async () => {
    try {
      const auth = await (
        await fetch('https://users.roblox.com/v1/users/authenticated', {
          credentials: 'include',
        })
      ).json();
      const userId = auth?.id as number;
      if (!userId) return [];
      const list = await (
        await fetch(`https://friends.roblox.com/v1/users/${userId}/friends`, {
          credentials: 'include',
        })
      ).json();
      const allFriends: { id: number; name?: string; displayName?: string }[] =
        list?.data ?? [];
      if (allFriends.length === 0) return [];
      const ids = allFriends.map((f) => f.id);
      const [presence, thumbs, info] = await Promise.all([
        fetch('https://presence.roblox.com/v1/presence/users', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userIds: ids }),
        })
          .then((r) => r.json())
          .catch(() => ({ userPresences: [] })),
        fetch(
          `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${ids.join(
            ','
          )}&size=48x48&format=Png&isCircular=false`,
          { credentials: 'include' }
        )
          .then((r) => r.json())
          .catch(() => ({ data: [] })),
        fetch('https://users.roblox.com/v1/users', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userIds: ids, excludeBannedUsers: false }),
        })
          .then((r) => r.json())
          .catch(() => ({ data: [] })),
      ]);
      const presenceById = new Map<number, number>();
      for (const p of presence?.userPresences ?? []) {
        presenceById.set(p.userId, p.userPresenceType ?? 0);
      }
      const thumbById = new Map<number, string>();
      for (const t of thumbs?.data ?? []) {
        thumbById.set(t.targetId, t.imageUrl);
      }
      const nameById = new Map<number, string>();
      for (const u of info?.data ?? []) {
        nameById.set(u.id, u.displayName || u.name || '');
      }
      const friends: ClassicFriend[] = allFriends.map((f) => {
        const pres = presenceById.get(f.id) ?? 0;
        return {
          id: f.id,
          name: nameById.get(f.id) || f.displayName || f.name || '',
          online: pres > 0,
          inGame: pres === 2,
          thumb: thumbById.get(f.id),
        };
      });
      // Online (in-game first), then plain online, then offline. Newest IDs
      // last as a stable tiebreaker.
      friends.sort((a, b) => {
        const score = (f: ClassicFriend) =>
          f.inGame ? 2 : f.online ? 1 : 0;
        return score(b) - score(a);
      });
      friendsBarCache = { fetchedAt: Date.now(), friends };
      return friends;
    } catch {
      return [];
    } finally {
      friendsBarInflight = null;
    }
  })();
  return friendsBarInflight;
}

function renderFriendsBar(friends: ClassicFriend[]): void {
  let bar = document.getElementById(FRIENDS_BAR_ID) as HTMLDivElement | null;
  if (!bar) {
    bar = document.createElement('div');
    bar.id = FRIENDS_BAR_ID;
    bar.style.cssText = [
      'position: fixed',
      'left: 174px',
      'right: 0',
      'bottom: 0',
      'height: 56px',
      'background: #1d2c52',
      'border-top: 1px solid #0d1a3a',
      'display: flex',
      'align-items: center',
      'padding: 0 8px',
      'gap: 6px',
      'overflow-x: auto',
      'overflow-y: hidden',
      'z-index: 90',
      "font-family: Arial, Helvetica, sans-serif",
      'font-size: 11px',
      'color: #ffffff',
      'white-space: nowrap',
    ].join(';');
    document.body.appendChild(bar);
  }
  const onlineCount = friends.filter((f) => f.online).length;
  bar.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = `Online (${onlineCount})`;
  label.style.cssText =
    'flex: 0 0 auto; padding: 0 10px 0 4px; font-weight: 700; color: #cfd6e6;';
  bar.appendChild(label);
  // Cap to 30 chips so we don't render hundreds of avatar img tags.
  const visible = friends.slice(0, 30);
  for (const f of visible) {
    const chip = document.createElement('a');
    chip.href = `https://www.roblox.com/users/${f.id}/profile`;
    chip.title = f.name + (f.inGame ? ' (in game)' : f.online ? ' (online)' : '');
    chip.style.cssText = [
      'flex: 0 0 auto',
      'display: inline-flex',
      'flex-direction: column',
      'align-items: center',
      'justify-content: center',
      'width: 42px',
      'height: 50px',
      'padding: 2px',
      'background: rgba(255,255,255,0.04)',
      'text-decoration: none',
      'color: #ffffff',
      'position: relative',
      'border-radius: 2px',
    ].join(';');
    const img = document.createElement('img');
    img.src = f.thumb || '';
    img.alt = f.name;
    img.style.cssText =
      'width: 32px; height: 32px; background: #e6e8eb; display: block;';
    const dot = document.createElement('span');
    dot.style.cssText = [
      'position: absolute',
      'left: 6px',
      'top: 4px',
      'width: 8px',
      'height: 8px',
      'border-radius: 50%',
      'border: 1px solid #1d2c52',
      `background: ${f.inGame ? '#2db84a' : f.online ? '#3fa9f5' : '#888'}`,
    ].join(';');
    const name = document.createElement('span');
    name.textContent = f.name.length > 7 ? f.name.slice(0, 6) + '…' : f.name;
    name.style.cssText =
      'font-size: 10px; line-height: 12px; max-width: 40px; overflow: hidden;';
    chip.appendChild(img);
    chip.appendChild(dot);
    chip.appendChild(name);
    bar.appendChild(chip);
  }
}

function removeFriendsBar(): void {
  document.getElementById(FRIENDS_BAR_ID)?.remove();
  friendsBarCache = null;
}

let friendsBarTimer: number | null = null;

async function ensureFriendsBar(): Promise<void> {
  const friends = await fetchClassicFriends();
  renderFriendsBar(friends);
  if (friendsBarTimer === null) {
    friendsBarTimer = window.setInterval(
      () => void ensureFriendsBar(),
      FRIENDS_BAR_TTL_MS
    );
  }
}

function clearFriendsBarTimer(): void {
  if (friendsBarTimer !== null) {
    clearInterval(friendsBarTimer);
    friendsBarTimer = null;
  }
}

let classicObserver: MutationObserver | null = null;
let classicDebounce: number | null = null;
let applySeq = 0;

function scheduleClassicTweaks(): void {
  if (classicDebounce !== null) return;
  classicDebounce = window.setTimeout(() => {
    classicDebounce = null;
    rewriteFriendAvatarsToFullbody();
    ensureUpgradeNowButton();
    ensureClassicLeftRailLabels();
  }, 120);
}

function activateClassic2016Tweaks(): void {
  scheduleClassicTweaks();
  void ensureFriendsBar();
  if (classicObserver) return;
  classicObserver = new MutationObserver(() => scheduleClassicTweaks());
  // Observe only the friend-tile container and the left-nav directly.
  // Hovering on game cards in sibling sections used to fire this observer
  // and re-run our tweaks, which manifested as thumbnail flicker on hover.
  const friendCarousel =
    document.querySelector('.react-friends-carousel-container') ||
    document.querySelector('.friend-carousel-container');
  const leftNav = document.querySelector('.left-nav');
  if (friendCarousel) {
    classicObserver.observe(friendCarousel, { childList: true, subtree: true });
  }
  if (leftNav) {
    classicObserver.observe(leftNav, { childList: true, subtree: true });
  }
  if (!friendCarousel && !leftNav) {
    // Bootstrap fallback when neither has mounted yet — re-attach the
    // observer to body briefly so it can re-bind on first render.
    classicObserver.observe(document.body, { childList: true });
  }
}

function deactivateClassic2016Tweaks(): void {
  classicObserver?.disconnect();
  classicObserver = null;
  if (classicDebounce !== null) {
    clearTimeout(classicDebounce);
    classicDebounce = null;
  }
  removeUpgradeNowButton();
  restoreFriendAvatars();
  restoreLeftRailLabels();
  clearFriendsBarTimer();
  removeFriendsBar();
}

async function applyCurrent(): Promise<void> {
  const seq = ++applySeq;
  const [settings, custom] = await Promise.all([getSettings(), getCustomTheme()]);
  if (seq !== applySeq) return;
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  // Any user-saved preset (id `custom`, `custom-2`, …) renders through the
  // same `'custom'` code path in buildCss / applyBackgroundImage. Built-in
  // preset ids stay as-is so era-specific CSS (Classic 2016 etc.) keeps firing.
  const isBuiltIn = PRESETS.some((p) => p.id === settings.themeId);
  const effectiveThemeId = isBuiltIn ? settings.themeId : 'custom';
  style.textContent = buildCss(effectiveThemeId, custom);
  applyBackgroundImage(custom, effectiveThemeId);
  // Production builds drop `classic-2016` from PRESETS; gate the DOM tweaks
  // on the same DEV flag so a stray themeId from synced storage can't trigger
  // a half-broken state (palette gone, era DOM hooks active).
  if (import.meta.env.DEV && settings.themeId === 'classic-2016') {
    activateClassic2016Tweaks();
  } else {
    deactivateClassic2016Tweaks();
  }
}

/**
 * Live-preview the background-image / mode / brightness from a theme draft
 * without writing to storage. Mutates the canonical `#bloxplus-theme-bg`
 * overlay so the user sees the image they just uploaded before they hit
 * Apply. `null` reverts to the saved state by re-running `applyCurrent`.
 */
export function setBackgroundImagePreview(custom: CustomTheme | null): void {
  if (!custom) {
    // Revert to saved → drop any live slider overrides so applyCurrent uses
    // the stored values.
    clearBackgroundPreviewOverrides();
    void applyCurrent();
    return;
  }
  applyBackgroundImage(custom, 'custom');
}

/**
 * Live-preview overlay for the themes page. Writes CSS into a separate
 * `<style id="bloxplus-theme-preview">` element that sits *after* the canonical
 * theme style, so it overrides without touching `chrome.storage`. Passing
 * `null` removes the overlay (Cancel).
 */
export function setPreviewTheme(custom: CustomTheme | null): void {
  let style = document.getElementById(PREVIEW_STYLE_ID) as HTMLStyleElement | null;
  if (!custom) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement('style');
    style.id = PREVIEW_STYLE_ID;
    document.head.appendChild(style);
  }
  // Preview always renders as the 'custom' theme regardless of the saved themeId,
  // so what the user sees in the editor is what Apply will commit.
  style.textContent = buildCss('custom', custom);
}

let listenersInstalled = false;

export async function run(): Promise<void> {
  await applyCurrent();
  if (listenersInstalled) return;
  listenersInstalled = true;
  onSettingsChanged(() => void applyCurrent());
  onCustomThemeChanged(() => void applyCurrent());
}
