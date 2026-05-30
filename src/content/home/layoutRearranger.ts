import { Settings } from '@/types';
import {
  FAVORITES_SECTION_ID,
  ensureFavoritesSection,
  ensureFavoritesStyle,
  getSectionTitle,
  MY_GAMES_SECTION_ID,
} from './favoritesSection';
import { FOLDERS_SECTION_ID, ensureFoldersSection } from './foldersSection';
import { ensureMyGamesSection } from './myGamesSection';
import { cleanupGroupCollapsible, makeGroupCollapsible } from './groupCollapsible';

export async function run(settings: Settings): Promise<void> {
  // Modern Roblox home: .game-home-page-container has a single (or near-single)
  // anonymous wrapper child, and *that* div is the actual parent of every
  // home section (friends, continue, standout, recommended, etc.).
  const outer = document.querySelector('.game-home-page-container');
  if (!(outer instanceof HTMLElement)) return;
  const innerChildren = [...outer.children].filter(
    (c): c is HTMLElement => c instanceof HTMLElement
  );
  // Pick the child with the most descendants — that's the section list.
  const root = innerChildren.reduce<HTMLElement | null>((best, c) => {
    if (c.id === FAVORITES_SECTION_ID) return best;
    if (!best || c.children.length > best.children.length) return c;
    return best;
  }, null);
  if (!root) return;

  ensureFavoritesStyle();

  const sections = [...root.children].filter(
    (el): el is HTMLElement => el instanceof HTMLElement
  );

  // homepageCleanup off → tear down all SviBlox-added home sections.
  if (!settings.homepageCleanup) {
    document.getElementById(FAVORITES_SECTION_ID)?.remove();
    document.getElementById(MY_GAMES_SECTION_ID)?.remove();
    document.getElementById(FOLDERS_SECTION_ID)?.remove();
  }

  // Hide Roblox's native "Favorites" section only while we render our own.
  // Best-effort English title match — locales that change the section name
  // will see ours and Roblox's both render (mild duplicate, not broken).
  for (const s of sections) {
    if (s.id === FAVORITES_SECTION_ID || s.id === MY_GAMES_SECTION_ID) continue;
    if (s.querySelector('.bp-section-toggle')) continue;
    if (/^favorites$/i.test(getSectionTitle(s).trim())) {
      s.style.display = settings.homepageCleanup ? 'none' : '';
      if (settings.homepageCleanup) s.dataset.bpHidden = '1';
      else delete s.dataset.bpHidden;
    }
  }

  const visibleSections = sections.filter((s) => s.style.display !== 'none');

  // Stable identification: friends has the `friend-carousel-container` class
  // (locale-independent), recommended grids carry `data-testid="home-page-game-grid"`,
  // and all the other carousels share class `game-sort-carousel-wrapper`. We
  // distinguish Continue from Standout by position (Continue is the first
  // sort carousel after Friends) which holds across locales without needing
  // a translation table. Title regex is kept as a fallback when Roblox
  // restructures.
  const friends = visibleSections.find(
    (s) =>
      !s.id.startsWith('bloxplus-') &&
      (s.classList.contains('friend-carousel-container') ||
        /friends/i.test(getSectionTitle(s)))
  );
  if (!friends) return;

  const isOwnSection = (s: HTMLElement): boolean =>
    s.id.startsWith('bloxplus-') || s.querySelector('.bp-section-toggle') !== null;

  const recommendedAll = visibleSections.filter(
    (s) => !isOwnSection(s) && s.getAttribute('data-testid') === 'home-page-game-grid'
  );
  const sortCarousels = visibleSections.filter(
    (s) =>
      !isOwnSection(s) &&
      s.classList.contains('game-sort-carousel-wrapper') &&
      !s.hasAttribute('data-bp-hidden')
  );

  // Within the sort carousels, the first one after Friends is Continue and
  // anything after that is Standout. Position-based since we can't trust
  // localized titles.
  const friendsIdx = visibleSections.indexOf(friends);
  const afterFriends = sortCarousels.filter(
    (s) => visibleSections.indexOf(s) > friendsIdx
  );
  const cont =
    afterFriends.find((s) => /continue/i.test(getSectionTitle(s))) ?? afterFriends[0];
  const standoutAll = afterFriends.filter((s) => s !== cont);

  const favorites = settings.homepageCleanup ? ensureFavoritesSection() : null;
  const folders = settings.homepageCleanup ? ensureFoldersSection() : null;
  const myGames = settings.homepageCleanup ? ensureMyGamesSection() : null;

  // Place sections in order, each immediately after the previous.
  // Folders sits between Favorites and My Games (user request).
  const desired = [
    cont,
    favorites,
    folders,
    myGames,
    standoutAll[0],
    recommendedAll[0],
  ].filter((s): s is HTMLElement => !!s);

  let anchor: HTMLElement = friends;
  for (const section of desired) {
    if (anchor.nextElementSibling !== section) {
      anchor.insertAdjacentElement('afterend', section);
    }
    anchor = section;
  }

  // Single shared dropdown that collapses BOTH Standout and Recommended
  // (including duplicates Roblox renders) at once. Runs after reorder so
  // the button ends up adjacent to the first grouped section.
  const grouped = [...standoutAll, ...recommendedAll];
  if (settings.homepageCleanup) {
    makeGroupCollapsible(grouped, 'Standout & Recommended');
  } else {
    cleanupGroupCollapsible();
  }
}
