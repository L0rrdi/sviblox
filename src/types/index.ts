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

export interface Settings {
  /**
   * Bundles all home-page layout features: Favorites + My Games + Folders
   * sections, plus the Standout/Recommended dropdown collapse.
   */
  homepageCleanup: boolean;
  /** Which folder is active on home page load. */
  foldersFolderSelection: 'previous' | 'random';
  /** How games are ordered inside the active folder. */
  foldersGamesSort: 'most-active' | 'least-active';
  /**
   * Service-worker presence polling AND the "Your Most Played" home widget.
   * One toggle for the whole playtime feature.
   */
  playtimeTracker: boolean;
  showGameBadges: boolean;
  showGameStoreDevProducts: boolean;
  showGameSubplaces: boolean;
  showTotalSpent: boolean;
  showAccountValue: boolean;
  showRobuxCash: boolean;
  robuxCashCurrency: 'USD' | 'GBP' | 'NOK';
  robuxCashRate: 'devex' | 'regular' | 'robloxPlus';
  /** Adds the "Themes" entry to the left nav and lets the themes overlay mount. */
  showThemes: boolean;
  /** Adds the "UHBL" entry to the left nav and lets the UHBL overlay mount. */
  showUhbl: boolean;
  themeId: string;
  homeWidgetWindow: string;
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
}

export const DEFAULT_SETTINGS: Settings = {
  homepageCleanup: true,
  foldersFolderSelection: 'previous',
  foldersGamesSort: 'most-active',
  playtimeTracker: false,
  showGameBadges: true,
  showGameStoreDevProducts: true,
  showGameSubplaces: true,
  showTotalSpent: false,
  showAccountValue: false,
  showRobuxCash: false,
  robuxCashCurrency: 'USD',
  robuxCashRate: 'regular',
  showThemes: true,
  showUhbl: true,
  themeId: 'default',
  homeWidgetWindow: 'all',
};
