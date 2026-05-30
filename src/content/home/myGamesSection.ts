import { getGameInfo, getGameVotes, GameInfo, GameVote } from '@/api/games';
import { getMyGames, OwnedGame } from '@/api/myGames';
import { getGameIcons } from '@/api/thumbnails';
import { getAuthenticatedUserId } from '@/api/users';
import { escapeHtml } from '@/util/html';
import {
  applyHomeListSnapshot,
  gameHref,
  HomeListSnapshot,
  homeGameTileHtml,
  MY_GAMES_SECTION_ID,
  myGamesSeeAllUrl,
  setHomeListSeeAllHref,
  ensureHomeListScroller,
  updateCurrentHomeListSection,
} from './favoritesSection';

// One-shot per page load. Mirrors favoritesSection — any failure that
// completes the first call also counts, since the MutationObserver would
// otherwise retry on every tick.
let myGamesLoaded = false;
let myGamesSnapshot: HomeListSnapshot | null = null;

export function ensureMyGamesSection(): HTMLElement {
  let section = document.getElementById(MY_GAMES_SECTION_ID);
  if (!section) {
    section = document.createElement('div');
    section.id = MY_GAMES_SECTION_ID;
    section.innerHTML = `
      <div class="bp-fav-header">
        <h2>My Games</h2>
        <div class="bp-fav-header-actions">
          <span class="bp-fav-meta">SviBlox</span>
          <a class="bp-fav-see-all" aria-disabled="true">See all</a>
        </div>
      </div>
      <ul class="bp-fav-row hlist games game-cards game-tile-list home-page-carousel">
        <li class="bp-fav-empty">Loading...</li>
      </ul>
    `;
  }
  ensureHomeListScroller(section);
  if (myGamesSnapshot) applyHomeListSnapshot(section, myGamesSnapshot);
  if (!myGamesLoaded) {
    myGamesLoaded = true;
    void loadMyGames(section);
  }
  return section;
}

async function loadMyGames(section: HTMLElement): Promise<void> {
  const rowEl = section.querySelector('.bp-fav-row') as HTMLElement;
  const metaEl = section.querySelector('.bp-fav-meta') as HTMLElement;

  const userId = await getAuthenticatedUserId();
  if (!userId) {
    myGamesSnapshot = {
      metaText: 'SviBlox',
      rowHtml: `<li class="bp-fav-error">Sign in to view your games.</li>`,
      seeAllHref: null,
    };
    updateCurrentHomeListSection(MY_GAMES_SECTION_ID, myGamesSnapshot, section);
    return;
  }
  const seeAllHref = myGamesSeeAllUrl(userId);
  setHomeListSeeAllHref(section, seeAllHref);

  let games: OwnedGame[];
  try {
    games = await getMyGames(userId, 50);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.error('[SviBlox] my games fetch failed:', e);
    myGamesSnapshot = {
      metaText: 'SviBlox',
      rowHtml: `<li class="bp-fav-error">Failed to load your games: ${escapeHtml(msg)}</li>`,
      seeAllHref,
    };
    updateCurrentHomeListSection(MY_GAMES_SECTION_ID, myGamesSnapshot, section);
    return;
  }

  if (!games.length) {
    myGamesSnapshot = {
      metaText: 'SviBlox',
      rowHtml: `<li class="bp-fav-empty">You haven't published any public games.</li>`,
      seeAllHref,
    };
    updateCurrentHomeListSection(MY_GAMES_SECTION_ID, myGamesSnapshot, section);
    return;
  }

  metaEl.textContent = `SviBlox · ${games.length} game${games.length === 1 ? '' : 's'}`;

  rowEl.innerHTML = games.map(myGameTilePlaceholder).join('');

  const universeIds = games.map((g) => g.id).filter((n): n is number => Number.isFinite(n));
  const [icons, info, votes] = await Promise.all([
    getGameIcons(universeIds),
    getGameInfo(universeIds),
    getGameVotes(universeIds),
  ]);
  myGamesSnapshot = {
    seeAllHref,
    metaText: `SviBlox · ${games.length} game${games.length === 1 ? '' : 's'}`,
    rowHtml: games
      .map((g) => myGameTile(g, icons.get(g.id), info.get(g.id), votes.get(g.id)))
      .join(''),
  };
  updateCurrentHomeListSection(MY_GAMES_SECTION_ID, myGamesSnapshot, section);
}

function myGameTilePlaceholder(g: OwnedGame): string {
  return homeGameTileHtml({
    universeId: g.id,
    placeId: g.rootPlace?.id,
    name: g.name,
    href: gameHref(g.rootPlace?.id, g.id),
    stats: {
      upVotes: g.totalUpVotes,
      downVotes: g.totalDownVotes,
      playerCount: g.playerCount,
    },
  });
}

function myGameTile(
  g: OwnedGame,
  icon: string | undefined,
  info: GameInfo | undefined,
  vote: GameVote | undefined
): string {
  return homeGameTileHtml({
    universeId: g.id,
    placeId: g.rootPlace?.id ?? info?.rootPlaceId,
    name: g.name,
    href: gameHref(g.rootPlace?.id ?? info?.rootPlaceId, g.id),
    icon,
    stats: {
      upVotes: g.totalUpVotes ?? vote?.upVotes,
      downVotes: g.totalDownVotes ?? vote?.downVotes,
      playerCount: g.playerCount ?? info?.playing,
    },
  });
}
