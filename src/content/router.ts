import { observeRouteChanges } from './domObserver';
import * as homeEnhancer from './homeEnhancer';
import * as profileEnhancer from './profileEnhancer';
import * as badgeEnhancer from './badgeEnhancer';
import * as gameStoreEnhancer from './gameStoreEnhancer';
import * as subplacesEnhancer from './subplacesEnhancer';
import * as spentEnhancer from './spentEnhancer';
import * as robuxCashEnhancer from './robuxCashEnhancer';
import * as catalogEnhancer from './catalogEnhancer';
import * as themeInjector from './themeInjector';
import * as leftNavEnhancer from './leftNavEnhancer';
import * as themesPage from './themesPage';

themesPage.install();

function dispatch(path: string): void {
  void homeEnhancer.run();
  if (/^\/users\/\d+/.test(path)) {
    void profileEnhancer.run();
  }
  void badgeEnhancer.run();
  void gameStoreEnhancer.run();
  void subplacesEnhancer.run();
  void spentEnhancer.run();
  void robuxCashEnhancer.run();
  if (/^\/catalog/.test(path)) {
    void catalogEnhancer.run();
  }
  // Always-on enhancers.
  void themeInjector.run();
  leftNavEnhancer.run();
  themesPage.run();
}

observeRouteChanges(dispatch);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes['bloxplus.settings']) {
    dispatch(location.pathname);
  }
});
