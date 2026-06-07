import { observeRouteChanges } from './domObserver';
import * as homeEnhancer from './homeEnhancer';
import * as badgeEnhancer from './badgeEnhancer';
import * as gameStoreEnhancer from './gameStoreEnhancer';
import * as subplacesEnhancer from './subplacesEnhancer';
import * as spentEnhancer from './spentEnhancer';
import * as robuxCashEnhancer from './robuxCashEnhancer';
import * as themeInjector from './themeInjector';
import * as themeScheduler from './themeScheduler';
import * as leftNavEnhancer from './leftNavEnhancer';
import * as themesPage from './themesPage';
import * as uhblPage from './uhblPage';
import * as badgerHubPage from './badgerHubPage';
import * as searchAutocomplete from './searchAutocomplete';
import * as addToFolderButton from './addToFolderButton';
import * as gamePlaytimeButton from './gamePlaytimeButton';
import * as folderTileDecorator from './folderTileDecorator';
import * as friendLastOnlineEnhancer from './friendLastOnlineEnhancer';
import * as terminatedProfileEnhancer from './terminatedProfileEnhancer';
import * as badgeDetailEnhancer from './badgeDetailEnhancer';
import * as itemBundleEnhancer from './itemBundleEnhancer';
import * as catalogSourceDownloadEnhancer from './catalogSourceDownloadEnhancer';
import * as serverFiltersEnhancer from './serverFiltersEnhancer';
import * as quickPlayEnhancer from './quickPlayEnhancer';
import * as accountValueEnhancer from './accountValueEnhancer';
import * as accountAgeEnhancer from './accountAgeEnhancer';
import * as mutualsEnhancer from './mutualsEnhancer';
import * as profileNotesEnhancer from './profileNotesEnhancer';
import * as friendNicknameDecorator from './friendNicknameDecorator';
import * as friendCategoriesPage from './friendCategoriesPage';
import * as friendCategoryDecorator from './friendCategoryDecorator';
import * as hotkeysEnhancer from './hotkeysEnhancer';
import * as favoritesPageEnhancer from './favoritesPageEnhancer';
import * as customizeApplier from './customizeApplier';
import * as customizeMode from './customizeMode';
import * as customizeMenuEntry from './customizeMenuEntry';
import { install as installBannedProfileTrap } from './bannedProfileTrap';
import { install as installCarouselWheelScroll } from './carouselWheelScroll';

themesPage.install();
uhblPage.install();
badgerHubPage.install();
customizeMode.install();
customizeMenuEntry.install();
friendCategoriesPage.install();
// Always-on click listener that stashes any clicked /users/{id}/profile
// userId so terminatedProfileEnhancer can recover it after Roblox redirects
// a banned profile to /request-error. Idempotent.
installBannedProfileTrap();
installRoProStorageReader();
// Single always-on wheel listener: rolling the wheel over a horizontal
// carousel scrolls it (up = right arrow, down = left arrow).
installCarouselWheelScroll();

function dispatch(): void {
  void homeEnhancer.run();
  void badgeEnhancer.run();
  void gameStoreEnhancer.run();
  void subplacesEnhancer.run();
  void spentEnhancer.run();
  void robuxCashEnhancer.run();
  // Playtime button dispatches BEFORE the folder button — both append to
  // .favorite-follow-vote-share, so first-insert wins the leftmost slot.
  void gamePlaytimeButton.run();
  void addToFolderButton.run();
  void folderTileDecorator.run();
  void friendLastOnlineEnhancer.run();
  void terminatedProfileEnhancer.run();
  void accountValueEnhancer.run();
  void accountAgeEnhancer.run();
  void profileNotesEnhancer.run();
  void friendNicknameDecorator.run();
  void friendCategoryDecorator.run();
  friendCategoriesPage.run();
  void hotkeysEnhancer.run();
  void favoritesPageEnhancer.run();
  mutualsEnhancer.run();
  void badgeDetailEnhancer.run();
  void itemBundleEnhancer.run();
  void catalogSourceDownloadEnhancer.run();
  serverFiltersEnhancer.run();
  quickPlayEnhancer.run();
  // Always-on enhancers.
  themeScheduler.run();
  void themeInjector.run();
  leftNavEnhancer.run();
  themesPage.run();
  uhblPage.run();
  badgerHubPage.run();
  customizeApplier.run();
  customizeMode.run();
  customizeMenuEntry.run();
  searchAutocomplete.run();
}

observeRouteChanges(dispatch);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes['bloxplus.settings']) {
    dispatch();
  }
  if (area === 'local' && changes['bloxplus.customizations']) {
    dispatch();
  }
});

function installRoProStorageReader(): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'bp-read-ropro-local-storage') return false;
    sendResponse({
      ok: true,
      url: location.href,
      records: readRoProStorageRecords(),
    });
    return false;
  });
}

function readRoProStorageRecords(): Array<{
  area: 'localStorage' | 'sessionStorage' | 'pageDom';
  key: string;
  value: string;
}> {
  return [
    ...readStorageArea('localStorage', localStorage),
    ...readStorageArea('sessionStorage', sessionStorage),
    ...readRoProDomRecords(),
  ];
}

function readStorageArea(
  area: 'localStorage' | 'sessionStorage',
  storage: Storage
): Array<{ area: 'localStorage' | 'sessionStorage'; key: string; value: string }> {
  const rows: Array<{ area: 'localStorage' | 'sessionStorage'; key: string; value: string }> = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key || !isLikelyRoProPlaytimeKey(key)) continue;
    const value = storage.getItem(key);
    if (value) rows.push({ area, key, value });
  }
  return rows;
}

function isLikelyRoProPlaytimeKey(key: string): boolean {
  return /ropro|most.?played|play.?time|time.?played/i.test(key);
}

function readRoProDomRecords(): Array<{ area: 'pageDom'; key: string; value: string }> {
  const rows = [...document.querySelectorAll<HTMLElement>('#mostPlayedContainer li.game-card')];
  const games = rows
    .map(readRoProDomGame)
    .filter((game): game is { placeId: number; gameName?: string; minutes: number } => game !== null);

  return games.length
    ? [{ area: 'pageDom', key: 'roproVisibleMostPlayed', value: JSON.stringify(games) }]
    : [];
}

function readRoProDomGame(
  tile: HTMLElement
): { placeId: number; gameName?: string; minutes: number } | null {
  const link = tile.querySelector<HTMLAnchorElement>('a.game-card-link[href*="/games/"]');
  const placeId = parsePositiveInt(link?.id) ?? parsePositiveInt(link?.href.match(/\/games\/(\d+)/)?.[1]);
  if (!placeId) return null;

  const timeText =
    tile.querySelector<HTMLElement>('[title^="Played for"]')?.getAttribute('title') ??
    tile.querySelector<HTMLElement>('.vote-percentage-label')?.textContent ??
    '';
  const minutes = readRoProMinutes(timeText);
  if (!minutes) return null;

  const gameName =
    tile.getAttribute('title')?.trim() ||
    tile.querySelector<HTMLElement>('.game-card-name, .game-name-title')?.textContent?.trim() ||
    undefined;

  return { placeId, gameName, minutes };
}

function readRoProMinutes(text: string): number | null {
  const normalized = text.replace(/,/g, '').toLowerCase();
  const explicitMinutes = normalized.match(/(\d+(?:\.\d+)?)\s*minutes?/);
  if (explicitMinutes) return Math.round(Number(explicitMinutes[1]));

  const hours = normalized.match(/(\d+(?:\.\d+)?)\s*hours?/);
  if (hours) return Math.round(Number(hours[1]) * 60);

  const bare = normalized.match(/(\d+(?:\.\d+)?)/);
  return bare ? Math.round(Number(bare[1])) : null;
}

function parsePositiveInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
