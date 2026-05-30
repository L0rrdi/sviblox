import { getGameInfo, getGameVotes } from '@/api/games';
import { formatCompactNumber, formatVotePercent } from './favoritesSection';

export async function run(): Promise<void> {
  // Tile-reuse handling: Roblox rotates friends through the same
  // .game-card-friend-info slot. Without checking the universeId, an old
  // chip from a previous game would stick to the slot after the game in
  // the link changes. We stamp the universeId on the chip and re-decorate
  // when it doesn't match the current link.
  const targets: Array<{ slot: HTMLElement; universeId: number }> = [];
  for (const slot of document.querySelectorAll<HTMLElement>('.game-card-friend-info')) {
    const link = slot.closest('a.game-card-link');
    const universeId = Number(link?.id);
    if (!Number.isFinite(universeId) || universeId <= 0) continue;
    const existing = slot.querySelector<HTMLElement>('.bp-friend-tile-stats');
    if (existing) {
      if (existing.dataset.bpUniverseId === String(universeId)) continue;
      existing.remove();
    }
    targets.push({ slot, universeId });
  }
  if (!targets.length) return;

  const universeIds = [...new Set(targets.map((t) => t.universeId))];
  const [info, votes] = await Promise.all([getGameInfo(universeIds), getGameVotes(universeIds)]);

  for (const { slot, universeId } of targets) {
    // The link may have rotated again during the await. Re-check and skip if
    // the slot now belongs to a different game.
    const link = slot.closest('a.game-card-link');
    if (Number(link?.id) !== universeId) continue;
    const existing = slot.querySelector<HTMLElement>('.bp-friend-tile-stats');
    if (existing?.dataset.bpUniverseId === String(universeId)) continue;
    existing?.remove();
    const v = votes.get(universeId);
    const i = info.get(universeId);
    const percent = formatVotePercent(v?.upVotes, v?.downVotes);
    const players = typeof i?.playing === 'number' ? formatCompactNumber(i.playing) : '';
    if (!percent && !players) continue;

    const stats = document.createElement('div');
    stats.className = 'bp-friend-tile-stats';
    stats.dataset.bpUniverseId = String(universeId);
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
