import { getGameInfo, getGameVotes } from '@/api/games';
import { formatCompactNumber, formatVotePercent } from './favoritesSection';

export async function run(): Promise<void> {
  const slots = [...document.querySelectorAll<HTMLElement>('.game-card-friend-info')].filter(
    (el) => !el.querySelector('.bp-friend-tile-stats')
  );
  if (!slots.length) return;

  const targets: Array<{ slot: HTMLElement; universeId: number }> = [];
  for (const slot of slots) {
    const link = slot.closest('a.game-card-link');
    const universeId = Number(link?.id);
    if (!Number.isFinite(universeId) || universeId <= 0) continue;
    targets.push({ slot, universeId });
  }
  if (!targets.length) return;

  const universeIds = [...new Set(targets.map((t) => t.universeId))];
  const [info, votes] = await Promise.all([getGameInfo(universeIds), getGameVotes(universeIds)]);

  for (const { slot, universeId } of targets) {
    if (slot.querySelector('.bp-friend-tile-stats')) continue;
    const v = votes.get(universeId);
    const i = info.get(universeId);
    const percent = formatVotePercent(v?.upVotes, v?.downVotes);
    const players = typeof i?.playing === 'number' ? formatCompactNumber(i.playing) : '';
    if (!percent && !players) continue;

    const stats = document.createElement('div');
    stats.className = 'bp-friend-tile-stats';
    stats.innerHTML = `
      ${
        percent
          ? `<span class="info-label icon-votes-gray"></span><span class="info-label vote-percentage-label">${percent}</span>`
          : ''
      }
      ${
        players
          ? `<span class="info-label icon-playing-counts-gray"></span><span class="info-label playing-counts-label">${players}</span>`
          : ''
      }
    `;
    slot.appendChild(stats);
  }
}
