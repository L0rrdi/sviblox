export type PlaytimeSource = 'imported_ropro' | 'tracked_extension' | 'manual_adjustment';

export interface GamePlaytimeEntry {
  universeId?: number;
  placeId?: number;
  gameName?: string;
  totalSeconds: number;
  importedSeconds: number;
  trackedSeconds: number;
  lastPlayedAt?: string;
  /**
   * Per-window seconds when the source provides them (e.g. RoPro's
   * mostPlayedUniverseCache stores separate "30" and "999" day windows).
   * Keyed by window label, e.g. "30", "999", "all".
   */
  windowSeconds?: Record<string, number>;
  /**
   * Rolling buckets for SviBlox-tracked time. Hour buckets power the
   * 24-hour view; day buckets power 7/30/365-day views without storing one
   * sample per minute.
   */
  trackingBuckets?: {
    hours?: Record<string, number>;
    days?: Record<string, number>;
  };
  sources: PlaytimeSource[];
  importMetadata?: {
    importedAt: string;
    sourceName: string;
    originalKeys?: string[];
  };
}

export interface CustomTheme {
  background?: string;       // hex / rgb / rgba
  /** Roblox's top header bar + left navigation strip. */
  nav?: string;
  text?: string;
  accent?: string;
  /** Data URL of an uploaded background image (capped ~16 MB). */
  backgroundImage?: string;
  /** How the bg image is laid out. */
  backgroundMode?: 'cover' | 'contain' | 'tile';
  /** 0–200; 100 = unmodified. Applied as a CSS `filter: brightness(N%)` on
   *  the background overlay only — does not affect the rest of the page. */
  backgroundBrightness?: number;
}

/**
 * A user-saved theme. The id is what `settings.themeId` stores; the legacy
 * single-custom-theme slot migrates into id `custom` with name `Custom #1`.
 * Subsequent user-created presets use ids `custom-2`, `custom-3`, …
 */
export interface UserThemeEntry {
  id: string;
  name: string;
  theme: CustomTheme;
}

export interface ThemeScheduleSlot {
  id: string;
  label: string;
  themeId: string;
  /** Local 24-hour time in HH:mm format. */
  startsAt: string;
}

export interface ThemeSchedule {
  enabled: boolean;
  slots: ThemeScheduleSlot[];
}

export interface Settings {
  /**
   * Bundles all home-page layout features: Favorites + My Games + Folders
   * sections, plus the Standout/Recommended dropdown collapse.
   */
  homepageCleanup: boolean;
  /** Which folder is active on home page load. */
  foldersFolderSelection: 'previous' | 'random';
  /** How games are ordered inside the active folder. */
  foldersGamesSort: 'most-active' | 'least-active' | 'random';
  /**
   * Service-worker presence polling AND the "Your Most Played" home widget.
   * One toggle for the whole playtime feature.
   */
  playtimeTracker: boolean;
  showGameBadges: boolean;
  /**
   * Tints the badge rarity percentage by tier (easy → green, impossible →
   * purple). Off = uniform text color matching the rest of the badge row.
   */
  showBadgeRarityColors: boolean;
  showGameStoreDevProducts: boolean;
  showGameSubplaces: boolean;
  showTotalSpent: boolean;
  showAccountValue: boolean;
  /**
   * Adds a non-interactive pill next to Friends/Followers/Following on
   * profile pages showing the user's account age in years and months.
   */
  showAccountAge: boolean;
  showRobuxCash: boolean;
  robuxCashCurrency: 'USD' | 'GBP' | 'NOK';
  robuxCashRate: 'devex' | 'regular' | 'robloxPlus';
  /** Adds the "Themes" entry to the left nav and lets the themes overlay mount. */
  showThemes: boolean;
  /** Adds the "UHBL" entry to the left nav and lets the UHBL overlay mount. */
  showUhbl: boolean;
  /**
   * Adds the "Customize" entry to the header settings dropdown and lets
   * customize mode mount. Customize mode lets the user rename, hide, reorder,
   * and re-icon nav and header items, and add new entries. Master switch —
   * when false, applied customizations stay in storage but are not applied to
   * the DOM.
   */
  showCustomize: boolean;
  /**
   * Profile notes + nicknames: editable card on other users' profiles and
   * the (nickname) cosmetic appended to displayed names site-wide.
   */
  showProfileNotes: boolean;
  /**
   * Single-key hotkeys mapping `destinationId -> keyChar`. Destinations are
   * the well-known IDs in `src/content/hotkeyDestinations.ts` or dynamic
   * `folder-game:{universeId}` IDs for games saved in local folders. Keys are
   * already lowercased + single-character. Hold `|` while no input is focused
   * to see the live binding list.
   */
  gameHotkeys: Record<string, string>;
  themeId: string;
  themeSchedule: ThemeSchedule;
  homeWidgetWindow: string;
  /**
   * Visually collapses the "Your Most Played" widget on the home page (only
   * the header + eye toggle stay visible). Playtime tracking continues —
   * this is purely a display preference. Separate from `playtimeTracker`
   * which is the master switch for the whole feature.
   */
  hideMostPlayedWidget: boolean;
  /**
   * Customize-mode-only: when true, items marked `hidden` render at low
   * opacity (instead of `display: none`) while you're in customize mode, so
   * you can find and un-hide them. Outside of customize mode they're still
   * fully hidden. Off = hidden means hidden everywhere — useful if a soft-
   * hidden item is still visually distracting.
   */
  customizeShowHiddenInMode: boolean;
}

export type UhblTier = 'SS' | 'S' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'N/A';

export interface UhblBadge {
  /** Position in the sheet (1-based) to preserve curator ordering. */
  order: number;
  badgeId: number;
  badgeName: string;
  gameName: string;
  obtainment: string;
  media: string;
  tags: string[];
  /**
   * Enjoyment Rating from col I (SS..F, N/A). NOT a difficulty rating —
   * the sheet uses STARDIV row markers in col J to delimit difficulty tiers.
   */
  tier: UhblTier;
  /**
   * Difficulty tier (1 = easiest, increasing toward the bottom of the sheet).
   * Derived from STARDIV separator rows; rendered as N stars in the UI.
   */
  difficulty: number;
  /** Roblox badge page URL straight from the sheet. */
  badgeUrl: string;
  /**
   * Optional video URL from the sheet's Media column (col E hyperlink).
   * Curators paste YouTube / streamable / etc. links onto the media-type
   * label; CSV export strips these, so they're pulled from the edit-view
   * bootstrap data — see uhblSheet.ts.
   */
  videoUrl?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  homepageCleanup: true,
  foldersFolderSelection: 'previous',
  foldersGamesSort: 'most-active',
  playtimeTracker: false,
  showGameBadges: true,
  showBadgeRarityColors: true,
  showGameStoreDevProducts: true,
  showGameSubplaces: true,
  showTotalSpent: false,
  showAccountValue: false,
  showAccountAge: false,
  showRobuxCash: false,
  robuxCashCurrency: 'USD',
  robuxCashRate: 'regular',
  showThemes: true,
  showUhbl: true,
  showCustomize: false,
  showProfileNotes: false,
  gameHotkeys: {},
  themeId: 'default',
  themeSchedule: {
    enabled: false,
    slots: [
      { id: 'morning', label: 'Morning', themeId: 'default', startsAt: '07:00' },
      { id: 'evening', label: 'Evening', themeId: 'dark-blue', startsAt: '19:00' },
    ],
  },
  homeWidgetWindow: 'all',
  hideMostPlayedWidget: false,
  customizeShowHiddenInMode: false,
};
