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
import * as searchAutocomplete from './searchAutocomplete';
import * as addToFolderButton from './addToFolderButton';
import * as folderTileDecorator from './folderTileDecorator';
import * as friendLastOnlineEnhancer from './friendLastOnlineEnhancer';
import * as terminatedProfileEnhancer from './terminatedProfileEnhancer';
import * as badgeDetailEnhancer from './badgeDetailEnhancer';
import * as itemBundleEnhancer from './itemBundleEnhancer';
import * as serverFiltersEnhancer from './serverFiltersEnhancer';
import * as quickPlayEnhancer from './quickPlayEnhancer';
import * as accountValueEnhancer from './accountValueEnhancer';
import * as mutualsEnhancer from './mutualsEnhancer';
import * as profileNotesEnhancer from './profileNotesEnhancer';
import * as friendNicknameDecorator from './friendNicknameDecorator';
import * as hotkeysEnhancer from './hotkeysEnhancer';
import * as favoritesPageEnhancer from './favoritesPageEnhancer';

themesPage.install();
uhblPage.install();

function dispatch(): void {
  void homeEnhancer.run();
  void badgeEnhancer.run();
  void gameStoreEnhancer.run();
  void subplacesEnhancer.run();
  void spentEnhancer.run();
  void robuxCashEnhancer.run();
  void addToFolderButton.run();
  void folderTileDecorator.run();
  void friendLastOnlineEnhancer.run();
  void terminatedProfileEnhancer.run();
  void accountValueEnhancer.run();
  void profileNotesEnhancer.run();
  void friendNicknameDecorator.run();
  void hotkeysEnhancer.run();
  void favoritesPageEnhancer.run();
  mutualsEnhancer.run();
  void badgeDetailEnhancer.run();
  void itemBundleEnhancer.run();
  serverFiltersEnhancer.run();
  quickPlayEnhancer.run();
  // Always-on enhancers.
  themeScheduler.run();
  void themeInjector.run();
  leftNavEnhancer.run();
  themesPage.run();
  uhblPage.run();
  searchAutocomplete.run();
}

observeRouteChanges(dispatch);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes['bloxplus.settings']) {
    dispatch();
  }
});
