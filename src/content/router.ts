import { observeRouteChanges } from './domObserver';
import * as homeEnhancer from './homeEnhancer';
import * as badgeEnhancer from './badgeEnhancer';
import * as gameStoreEnhancer from './gameStoreEnhancer';
import * as subplacesEnhancer from './subplacesEnhancer';
import * as spentEnhancer from './spentEnhancer';
import * as robuxCashEnhancer from './robuxCashEnhancer';
import * as themeInjector from './themeInjector';
import * as leftNavEnhancer from './leftNavEnhancer';
import * as themesPage from './themesPage';
import * as uhblPage from './uhblPage';
import * as searchAutocomplete from './searchAutocomplete';
import * as addToFolderButton from './addToFolderButton';
import * as folderTileDecorator from './folderTileDecorator';
import * as friendLastOnlineEnhancer from './friendLastOnlineEnhancer';
import * as terminatedProfileEnhancer from './terminatedProfileEnhancer';
import * as badgeDetailEnhancer from './badgeDetailEnhancer';
import * as serverFiltersEnhancer from './serverFiltersEnhancer';
import * as quickPlayEnhancer from './quickPlayEnhancer';
import * as accountValueEnhancer from './accountValueEnhancer';
import * as mutualsEnhancer from './mutualsEnhancer';

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
  mutualsEnhancer.run();
  void badgeDetailEnhancer.run();
  serverFiltersEnhancer.run();
  quickPlayEnhancer.run();
  // Always-on enhancers.
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
