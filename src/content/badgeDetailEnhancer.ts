/**
 * On `/badges/{id}/...` pages: insert a "Badges Awarded" row alongside the
 * native Type / Updated / Description meta rows. Plain Roblox styling.
 */

import { getBadgeDetail } from '@/api/badges';

const ROW_ID = 'bloxplus-badge-awarded-row';

let renderedFor: number | null = null;

export async function run(): Promise<void> {
  const badgeId = parseBadgeId();
  if (!badgeId) {
    cleanup();
    return;
  }
  if (renderedFor === badgeId && document.getElementById(ROW_ID)) return;

  const descRow = await waitFor<HTMLElement>(
    () => findFieldRow('Description') as HTMLElement | null
  );
  if (!descRow) return;

  const detail = await getBadgeDetail(badgeId);
  const count = detail?.statistics?.awardedCount ?? 0;

  insertAwardedRow(descRow, count);
  renderedFor = badgeId;
}

function cleanup(): void {
  document.getElementById(ROW_ID)?.remove();
  renderedFor = null;
}

function parseBadgeId(): number | null {
  const m = location.pathname.match(/^\/badges\/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function findFieldRow(label: string): Element | null {
  const rows = document.querySelectorAll('.item-field-container');
  for (const r of rows) {
    const lab = r.querySelector('.field-label');
    if (lab?.textContent?.trim() === label) return r;
  }
  return null;
}

function insertAwardedRow(descRow: HTMLElement, count: number): void {
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
  descRow.insertAdjacentElement('afterend', row);
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
