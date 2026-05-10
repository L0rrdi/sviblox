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
  card?: string;
  text?: string;
  accent?: string;
  border?: string;
  /** Data URL of an uploaded background image (capped ~2 MB). */
  backgroundImage?: string;
  /** How the bg image is laid out. */
  backgroundMode?: 'cover' | 'contain' | 'tile';
}

export interface Settings {
  highlightOwnedBadges: boolean;
  sortBadgesEnabled: boolean;
  showJoinedDate: boolean;
  showAvatarItems: boolean;
  showOwnedCatalogItems: boolean;
  showAccountValue: boolean;
  showMutualFriends: boolean;
  showMostPlayedWidget: boolean;
  showHomeFavorites: boolean;
  showHomeMyGames: boolean;
  showFriendTileStats: boolean;
  collapseDiscoverSections: boolean;
  showGameBadges: boolean;
  showGameStoreDevProducts: boolean;
  showGameSubplaces: boolean;
  showTotalSpent: boolean;
  showRobuxCash: boolean;
  robuxCashCurrency: 'USD' | 'GBP' | 'NOK';
  robuxCashRate: 'devex' | 'regular' | 'robloxPlus';
  enablePlaytimeTracking: boolean;
  themeId: string;
  dateFormat: string;
  homeWidgetWindow: string;
}

export const DEFAULT_SETTINGS: Settings = {
  highlightOwnedBadges: true,
  sortBadgesEnabled: true,
  showJoinedDate: true,
  showAvatarItems: true,
  showOwnedCatalogItems: true,
  showAccountValue: true,
  showMutualFriends: true,
  showMostPlayedWidget: true,
  showHomeFavorites: true,
  showHomeMyGames: true,
  showFriendTileStats: true,
  collapseDiscoverSections: true,
  showGameBadges: true,
  showGameStoreDevProducts: true,
  showGameSubplaces: true,
  showTotalSpent: false,
  showRobuxCash: false,
  robuxCashCurrency: 'USD',
  robuxCashRate: 'regular',
  enablePlaytimeTracking: false,
  themeId: 'default',
  dateFormat: 'long',
  homeWidgetWindow: 'all',
};
