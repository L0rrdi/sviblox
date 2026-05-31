import { getGameInfo, getGameVotes, GameInfo, GameVote } from '@/api/games';
import { getMyGames, OwnedGame } from '@/api/myGames';
import { getGameIcons } from '@/api/thumbnails';
import { getAuthenticatedUserIdFresh } from '@/api/users';
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

// One-shot per signed-in Roblox user. Mirrors favoritesSection so switching
// accounts does not keep showing the previous user's creations row.
const SIGNED_OUT_MY_GAMES_KEY = 'signed-out';
const MY_GAMES_USER_CHECK_MS = 15_000;
let myGamesUserKey: string | null = null;
let myGamesUserCheckedAt = 0;
let myGamesUserCheckInFlight: Promise<void> | null = null;
const myGamesSnapshots = new Map<string, HomeListSnapshot>();

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
  if (myGamesUserKey) {
    const snapshot = myGamesSnapshots.get(myGamesUserKey);
    if (snapshot) applyHomeListSnapshot(section, snapshot);
  }
  void ensureMyGamesForCurrentUser(section);
  return section;
}

async function ensureMyGamesForCurrentUser(section: HTMLElement): Promise<void> {
  if (
    myGamesUserCheckInFlight ||
    (myGamesUserKey && Date.now() - myGamesUserCheckedAt < MY_GAMES_USER_CHECK_MS)
  ) {
    return myGamesUserCheckInFlight ?? undefined;
  }

  myGamesUserCheckInFlight = (async () => {
    const userId = await getAuthenticatedUserIdFresh();
    myGamesUserCheckedAt = Date.now();
    const nextKey = userId ? String(userId) : SIGNED_OUT_MY_GAMES_KEY;
    if (nextKey === myGamesUserKey && myGamesSnapshots.has(nextKey)) return;

    myGamesUserKey = nextKey;
    const cached = myGamesSnapshots.get(nextKey);
    if (cached) {
      updateCurrentHomeListSection(MY_GAMES_SECTION_ID, cached, section);
      return;
    }

    const loadingSnapshot: HomeListSnapshot = {
      metaText: 'SviBlox',
      rowHtml: '<li class="bp-fav-empty">Loading...</li>',
      seeAllHref: userId ? myGamesSeeAllUrl(userId) : null,
    };
    updateCurrentHomeListSection(MY_GAMES_SECTION_ID, loadingSnapshot, section);
    await loadMyGamesForUser(section, userId, nextKey);
  })().finally(() => {
    myGamesUserCheckInFlight = null;
  });
  return myGamesUserCheckInFlight;
}

async function loadMyGamesForUser(
  section: HTMLElement,
  userId: number | null,
  userKey: string
): Promise<void> {
  const rowEl = section.querySelector('.bp-fav-row') as HTMLElement;
  const metaEl = section.querySelector('.bp-fav-meta') as HTMLElement;

  if (!userId) {
    const snapshot = {
      metaText: 'SviBlox',
      rowHtml: `<li class="bp-fav-error">Sign in to view your games.</li>`,
      seeAllHref: null,
    };
    myGamesSnapshots.set(userKey, snapshot);
    updateCurrentMyGamesSection(userKey, snapshot, section);
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
    const snapshot = {
      metaText: 'SviBlox',
      rowHtml: `<li class="bp-fav-error">Failed to load your games: ${escapeHtml(msg)}</li>`,
      seeAllHref,
    };
    myGamesSnapshots.set(userKey, snapshot);
    updateCurrentMyGamesSection(userKey, snapshot, section);
    return;
  }

  if (!games.length) {
    const snapshot = {
      metaText: 'SviBlox',
      rowHtml: `<li class="bp-fav-empty">You haven't published any public games.</li>`,
      seeAllHref,
    };
    myGamesSnapshots.set(userKey, snapshot);
    updateCurrentMyGamesSection(userKey, snapshot, section);
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
  const snapshot = {
    seeAllHref,
    metaText: `SviBlox · ${games.length} game${games.length === 1 ? '' : 's'}`,
    rowHtml: games
      .map((g) => myGameTile(g, icons.get(g.id), info.get(g.id), votes.get(g.id)))
      .join(''),
  };
  myGamesSnapshots.set(userKey, snapshot);
  updateCurrentMyGamesSection(userKey, snapshot, section);
}

function updateCurrentMyGamesSection(
  userKey: string,
  snapshot: HomeListSnapshot,
  section: HTMLElement
): void {
  if (myGamesUserKey !== userKey) return;
  updateCurrentHomeListSection(MY_GAMES_SECTION_ID, snapshot, section);
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
