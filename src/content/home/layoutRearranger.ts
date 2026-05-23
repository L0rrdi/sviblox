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

const DEBUG_HOME_LAYOUT = false;
const debugOnceSeen = new Set<string>();
let lastDebugSnapshot = '';

function debugOnce(msg: string): void {
  if (!DEBUG_HOME_LAYOUT) return;
  if (debugOnceSeen.has(msg)) return;
  debugOnceSeen.add(msg);
  console.log('[SviBlox]', msg);
}


export async function run(settings: Settings): Promise<void> {
  // Modern Roblox home: .game-home-page-container has a single (or near-single)
  // anonymous wrapper child, and *that* div is the actual parent of every
  // home section (friends, continue, standout, recommended, etc.).
  const outer = document.querySelector('.game-home-page-container');
  if (!(outer instanceof HTMLElement)) {
    debugOnce('rearrange: no .game-home-page-container');
    return;
  }
  const innerChildren = [...outer.children].filter(
    (c): c is HTMLElement => c instanceof HTMLElement
  );
  // Pick the child with the most descendants — that's the section list.
  const root = innerChildren.reduce<HTMLElement | null>((best, c) => {
    if (c.id === FAVORITES_SECTION_ID) return best;
    if (!best || c.children.length > best.children.length) return c;
    return best;
  }, null);
  if (!root) {
    debugOnce('rearrange: no inner section root');
    return;
  }

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

  // Debug-log the section titles, once per change.
  const snapshot = visibleSections
    .map((s) => getSectionTitle(s).slice(0, 40) || '(unknown)')
    .join(' | ');
  if (DEBUG_HOME_LAYOUT && snapshot !== lastDebugSnapshot) {
    console.log('[SviBlox] sections found:', snapshot);
    lastDebugSnapshot = snapshot;
  }

  const findByTitle = (matcher: RegExp): HTMLElement | undefined =>
    visibleSections.find(
      (s) =>
        matcher.test(getSectionTitle(s)) &&
        !s.id.startsWith('bloxplus-')
    );
  const findAllByTitle = (matcher: RegExp): HTMLElement[] =>
    visibleSections.filter(
      (s) =>
        matcher.test(getSectionTitle(s)) &&
        !s.id.startsWith('bloxplus-')
    );

  const friends = findByTitle(/friends/i);
  if (!friends) {
    debugOnce('rearrange: no friends section yet');
    return;
  }

  const cont = findByTitle(/continue/i);
  const standout = findByTitle(/standout/i);
  const recommended = findByTitle(/recommended/i);
  const favorites = settings.homepageCleanup ? ensureFavoritesSection() : null;
  const folders = settings.homepageCleanup ? ensureFoldersSection() : null;
  const myGames = settings.homepageCleanup ? ensureMyGamesSection() : null;

  // Place sections in order, each immediately after the previous.
  // Folders sits between Favorites and My Games (user request).
  const desired = [cont, favorites, folders, myGames, standout, recommended].filter(
    (s): s is HTMLElement => !!s
  );

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
  const grouped = [
    ...findAllByTitle(/standout/i),
    ...findAllByTitle(/recommended/i),
  ];
  if (settings.homepageCleanup) {
    makeGroupCollapsible(grouped, 'Standout & Recommended');
  } else {
    cleanupGroupCollapsible();
  }
}
