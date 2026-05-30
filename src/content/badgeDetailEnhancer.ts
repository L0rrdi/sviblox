/**
 * On `/badges/{id}/...` pages: insert a "Badges Awarded" row alongside the
 * native Type / Updated / Description meta rows. Plain Roblox styling.
 */

import { getBadgeDetail } from '@/api/badges';

const ROW_ID = 'bloxplus-badge-awarded-row';

let renderedFor: number | null = null;
let loadSeq = 0;

export async function run(): Promise<void> {
  const badgeId = parseBadgeId();
  if (!badgeId) {
    cleanup();
    return;
  }
  if (renderedFor === badgeId && document.getElementById(ROW_ID)) return;

  const seq = ++loadSeq;
  const path = location.pathname;
  const anchorRow = await waitFor<HTMLElement>(findInsertionRow);
  if (!anchorRow || isStale(seq, path, badgeId)) return;

  const detail = await getBadgeDetail(badgeId);
  if (isStale(seq, path, badgeId) || !detail?.statistics) return;
  const count = detail.statistics.awardedCount;

  insertAwardedRow(anchorRow, count);
  renderedFor = badgeId;
}

function cleanup(): void {
  document.getElementById(ROW_ID)?.remove();
  renderedFor = null;
  loadSeq += 1;
}

function parseBadgeId(): number | null {
  const m = location.pathname.match(/^\/badges\/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function findInsertionRow(): HTMLElement | null {
  const rows = [...document.querySelectorAll<HTMLElement>('.item-field-container')]
    .filter((row) => row.id !== ROW_ID);
  return rows.at(-1) ?? null;
}

function isStale(seq: number, path: string, badgeId: number): boolean {
  return seq !== loadSeq || location.pathname !== path || parseBadgeId() !== badgeId;
}

function insertAwardedRow(anchorRow: HTMLElement, count: number): void {
  document.getElementById(ROW_ID)?.remove();
  const row = document.createElement('div');
  row.id = ROW_ID;
  row.className = 'clearfix item-field-container';
  const label = document.createElement('div');
  label.className = 'font-header-1 text-subheader text-label text-overflow field-label';
  label.textContent = 'Badges Awarded';
  const value = document.createElement('p');
  value.className = 'field-content font-body text';
  value.textContent = count.toLocaleString();
  row.appendChild(label);
  row.appendChild(value);
  anchorRow.insertAdjacentElement('afterend', row);
}

async function waitFor<T extends Element>(
  probe: () => T | null,
  timeoutMs = 4000
): Promise<T | null> {
  const found = probe();
  if (found) return found;
  return new Promise<T | null>((resolve) => {
    const start = Date.now();
    const obs = new MutationObserver(() => {
      const f = probe();
      if (f) {
        obs.disconnect();
        resolve(f);
      } else if (Date.now() - start > timeoutMs) {
        obs.disconnect();
        resolve(null);
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      obs.disconnect();
      resolve(probe());
    }, timeoutMs);
  });
}
