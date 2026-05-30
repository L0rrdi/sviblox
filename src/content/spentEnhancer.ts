import { placeIdToUniverseId } from '@/api/games';
import { getUserGamePurchases, sumPurchasesForUniverse } from '@/api/transactions';
import { getAuthenticatedUserId } from '@/api/users';
import { getSettings } from '@/storage/settingsStore';
import { formatCash, robuxToCash } from '@/utils/robuxRates';
import type { Settings } from '@/types';

const STYLE_ID = 'bloxplus-spent-style';
const LINE_ID = 'bloxplus-spent-line';

let renderedFor: number | null = null;
let inFlight = false;
const failedUniverses = new Map<number, string>();

export async function run(): Promise<void> {
  const placeId = parsePlaceIdFromUrl();
  if (!placeId) {
    cleanup();
    return;
  }

  const settings = await getSettings();
  if (!settings.showTotalSpent) {
    cleanup();
    return;
  }

  ensureStyle();

  const universeId = readUniverseIdFromPage() ?? (await placeIdToUniverseId(placeId));
  if (!universeId) return;

  const userId = await getAuthenticatedUserId();
  if (!userId) {
    const line = ensureLine();
    if (line) renderText(line, 'Total spent: sign in to view.');
    return;
  }

  if (renderedFor === universeId && document.getElementById(LINE_ID)) return;

  const priorError = failedUniverses.get(universeId);
  if (priorError) {
    const line = ensureLine();
    if (line) renderText(line, `Total spent: ${priorError}`);
    renderedFor = universeId;
    return;
  }

  if (inFlight) return;
  inFlight = true;

  const line = ensureLine();
  if (!line) {
    inFlight = false;
    return;
  }
  renderText(line, 'Total spent: loading...');

  // Transactions paginate up to 30 pages. If the user switches games during
  // the fetch, we must not write the previous universe's totals onto the new
  // game's line — re-check at write time.
  const requestedUniverseId = universeId;

  try {
    const transactions = await getUserGamePurchases(userId);
    const currentUniverseId = readUniverseIdFromPage();
    if (currentUniverseId && currentUniverseId !== requestedUniverseId) return;
    const writeLine = ensureLine();
    if (!writeLine) return;
    const { totalRobux, count } = sumPurchasesForUniverse(transactions, requestedUniverseId);
    renderTotal(writeLine, totalRobux, count, settings);
    renderedFor = requestedUniverseId;
  } catch (e) {
    const currentUniverseId = readUniverseIdFromPage();
    if (currentUniverseId && currentUniverseId !== requestedUniverseId) return;
    const msg = (e as Error)?.message ?? String(e);
    const message = `failed (${msg})`;
    failedUniverses.set(requestedUniverseId, message);
    const writeLine = ensureLine();
    if (writeLine) renderText(writeLine, `Total spent: ${message}`);
    renderedFor = requestedUniverseId;
  } finally {
    inFlight = false;
  }
}

function cleanup(): void {
  document.getElementById(LINE_ID)?.remove();
  renderedFor = null;
}

function parsePlaceIdFromUrl(): number | null {
  const m = location.pathname.match(/^\/games\/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readUniverseIdFromPage(): number | null {
  const meta = document.getElementById('game-detail-meta-data');
  const value = meta?.getAttribute('data-universe-id');
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function ensureLine(): HTMLElement | null {
  let line = document.getElementById(LINE_ID);

  // Anchor in the Store tab — prefer the Game Passes section header so the
  // text sits at the top of the user's purchase area.
  const store = document.getElementById('store');
  if (!(store instanceof HTMLElement)) {
    line?.remove();
    return null;
  }

  const header =
    store.querySelector('#rbx-game-passes .container-header') ??
    store.querySelector('.container-header') ??
    store.querySelector('#rbx-game-passes') ??
    store;
  if (!(header instanceof HTMLElement)) {
    line?.remove();
    return null;
  }

  if (!line) {
    line = document.createElement('div');
    line.id = LINE_ID;
    line.className = 'bp-spent-line';
  }
  if (line.parentElement !== header && header.firstElementChild !== line) {
    header.insertAdjacentElement('afterbegin', line);
  }
  return line;
}

function renderText(line: HTMLElement, text: string): void {
  line.textContent = text;
}

function renderTotal(
  line: HTMLElement,
  totalRobux: number,
  count: number,
  settings: Settings
): void {
  if (totalRobux <= 0 || count <= 0) {
    line.textContent = 'Total spent: none on this experience.';
    return;
  }

  const robuxText = `R$ ${formatNumber(totalRobux)}`;
  const purchaseText = `${count} ${count === 1 ? 'purchase' : 'purchases'}`;
  const cashText = settings.showRobuxCash
    ? ` (~${formatCash(
        robuxToCash(totalRobux, settings.robuxCashRate, settings.robuxCashCurrency),
        settings.robuxCashCurrency
      )})`
    : '';

  line.textContent = `Total spent: ${robuxText}${cashText} · ${purchaseText}`;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .bp-spent-line {
      margin: 4px 0 8px 0;
      font-size: 12px;
      font-weight: 600;
      opacity: 0.85;
    }
    body.bp-has-bg-image .bp-spent-line {
      color: #fff !important;
      text-shadow: 0 1px 2px rgba(0,0,0,0.6);
    }
  `;
  document.head.appendChild(style);
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}
