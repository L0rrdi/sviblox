import { getDeveloperProducts, DeveloperProduct } from '@/api/developerProducts';
import { placeIdToUniverseId } from '@/api/games';
import { getDeveloperProductIcons } from '@/api/thumbnails';
import { getSettings } from '@/storage/settingsStore';
import { escapeHtml } from '@/util/html';

const STYLE_ID = 'bloxplus-dev-products-style';
const SECTION_ID = 'bloxplus-dev-products-section';

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
  if (!settings.showGameStoreDevProducts) {
    cleanup();
    return;
  }

  ensureStyle();

  const passesSection = findPassesSection();
  if (!passesSection) {
    cleanup();
    return;
  }

  const universeId = readUniverseIdFromPage() ?? (await placeIdToUniverseId(placeId));
  if (!universeId) return;

  const priorError = failedUniverses.get(universeId);
  if (priorError) {
    renderError(ensureSection(passesSection), priorError);
    renderedFor = universeId;
    return;
  }

  if (renderedFor === universeId && document.getElementById(SECTION_ID)) return;
  if (inFlight) return;

  inFlight = true;
  const section = ensureSection(passesSection);
  section.innerHTML = sectionShell('<div class="bp-dev-products-empty">Loading dev products...</div>');

  try {
    const products = await getDeveloperProducts(universeId);
    if (!products.length) {
      section.remove();
      renderedFor = universeId;
      return;
    }

    const iconIds = products.map((product) => product.id);
    const icons = await getDeveloperProductIcons(iconIds);
    renderProducts(section, products, icons, readSellerInfoFromPage());
    renderedFor = universeId;
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    const message = `Failed to load dev products: ${escapeHtml(msg)}`;
    failedUniverses.set(universeId, message);
    renderError(section, message);
    renderedFor = universeId;
  } finally {
    inFlight = false;
  }
}

function cleanup(): void {
  document.getElementById(SECTION_ID)?.remove();
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

interface SellerInfo {
  id: number;
  name: string;
}

function readSellerInfoFromPage(): SellerInfo {
  const meta = document.getElementById('game-detail-meta-data');
  const id = Number(meta?.getAttribute('data-seller-id') || 0);
  return {
    id: Number.isFinite(id) ? id : 0,
    name: meta?.getAttribute('data-seller-name') || '',
  };
}

function findPassesSection(): HTMLElement | null {
  const store = document.querySelector('#store.active, #store.tab-pane.active');
  if (!(store instanceof HTMLElement)) return null;
  const passes = store.querySelector('#rbx-game-passes');
  return passes instanceof HTMLElement ? passes : null;
}

function ensureSection(passesSection: HTMLElement): HTMLElement {
  let section = document.getElementById(SECTION_ID);
  if (!section) {
    section = document.createElement('div');
    section.id = SECTION_ID;
    section.className = 'container-list game-dev-store game-passes bp-dev-products';
    passesSection.insertAdjacentElement('afterend', section);
  } else if (section.previousElementSibling !== passesSection) {
    passesSection.insertAdjacentElement('afterend', section);
  }
  if (!section.dataset.bpStoreBound) {
    section.dataset.bpStoreBound = '1';
    section.addEventListener('click', handleSectionClick);
  }
  return section;
}

function renderProducts(
  section: HTMLElement,
  products: DeveloperProduct[],
  icons: Map<number, string>,
  seller: SellerInfo
): void {
  section.innerHTML = sectionShell(products.map((product) => productCard(product, icons, seller)).join(''));
}

function renderError(section: HTMLElement, message: string): void {
  section.innerHTML = sectionShell(`<div class="bp-dev-products-empty">${message}</div>`);
}

function sectionShell(content: string): string {
  return `
    <div class="container-header bp-dev-products-header">
      <div class="bp-dev-products-title">
        <button
          class="bp-dev-products-toggle"
          type="button"
          aria-expanded="true"
          aria-controls="bloxplus-dev-products-list"
        >Hide ^</button>
        <h3>Dev Products</h3>
      </div>
    </div>
    <ul id="bloxplus-dev-products-list" class="hlist store-cards gear-passes-container bp-dev-products-list">
      ${content}
    </ul>
  `;
}

function productCard(
  product: DeveloperProduct,
  icons: Map<number, string>,
  seller: SellerInfo
): string {
  const name = escapeHtml(product.name);
  const price = typeof product.priceInRobux === 'number' ? product.priceInRobux : 0;
  const canTryPurchase = price > 0;
  const image = icons.get(product.id);
  const sellerId = product.creator?.id ?? seller.id;
  const sellerName = product.creator?.name ?? seller.name;

  return `
    <li class="list-item real-game-pass bp-dev-product">
      <div class="store-card">
        <span class="gear-passes-asset bp-dev-product-thumb">
          ${
            image
              ? `<img src="${escapeHtml(image)}" alt="${name}" loading="lazy" />`
              : `<span class="bp-dev-product-placeholder" aria-hidden="true"></span>`
          }
        </span>
        <div class="store-card-caption">
          <div class="text-overflow store-card-name" title="${name}">${name}</div>
          <div class="store-card-price">
            <span class="icon-robux-16x16"></span>
            <span class="text-robux">${price ? formatNumber(price) : '?'}</span>
          </div>
          <div class="store-card-footer">
            <button
              class="PurchaseButton btn-buy-md btn-full-width rbx-gear-passes-purchase bp-dev-product-purchase"
              type="button"
              ${canTryPurchase ? '' : 'disabled'}
              data-item-id="${product.id}"
              data-product-id="${product.productId}"
              data-item-name="${name}"
              data-asset-type="Developer Product"
              data-expected-price="${price}"
              data-expected-seller-id="${sellerId}"
              data-seller-name="${escapeHtml(sellerName)}"
              data-image-url="${image ? escapeHtml(image) : ''}"
            >
              <span>${canTryPurchase ? 'Buy' : 'Unavailable'}</span>
            </button>
            <div class="bp-dev-product-message" aria-live="polite"></div>
          </div>
        </div>
      </div>
    </li>
  `;
}

function handleSectionClick(event: MouseEvent): void {
  const toggle = (event.target as Element | null)?.closest('.bp-dev-products-toggle');
  if (toggle instanceof HTMLButtonElement) {
    event.preventDefault();
    toggleDevProducts(toggle);
    return;
  }
  handlePurchaseClick(event);
}

function toggleDevProducts(button: HTMLButtonElement): void {
  const section = button.closest(`#${SECTION_ID}`);
  if (!(section instanceof HTMLElement)) return;
  const collapsed = !section.classList.contains('bp-dev-products-collapsed');
  section.classList.toggle('bp-dev-products-collapsed', collapsed);
  button.setAttribute('aria-expanded', String(!collapsed));
  button.textContent = collapsed ? 'Show v' : 'Hide ^';
}

function handlePurchaseClick(event: MouseEvent): void {
  const button = (event.target as Element | null)?.closest('.bp-dev-product-purchase');
  if (!(button instanceof HTMLButtonElement)) return;
  event.preventDefault();

  const productId = Number(button.dataset.productId || button.dataset.itemId);
  const developerProductId = Number(button.dataset.itemId || button.dataset.productId);
  const expectedPrice = Number(button.dataset.expectedPrice || 0);
  const expectedSellerId = Number(button.dataset.expectedSellerId || 0);

  const purchaseOptions = {
    productId,
    developerProductId,
    assetName: button.dataset.itemName || '',
    expectedPrice,
    expectedSellerId,
    sellerName: button.dataset.sellerName || '',
    imageUrl: button.dataset.imageUrl || '',
  };

  if (tryUnifiedDeveloperProductPurchase(purchaseOptions)) return;
  if (tryLegacyDeveloperProductPurchase(button)) return;

  showPurchaseMessage(button, 'Roblox did not expose the web purchase prompt on this page.');
}

interface PurchaseOptions {
  productId: number;
  developerProductId: number;
  assetName: string;
  expectedPrice: number;
  expectedSellerId: number;
  sellerName: string;
  imageUrl: string;
}

function tryUnifiedDeveloperProductPurchase(options: PurchaseOptions): boolean {
  const api = (
    window as Window & {
      RobloxItemPurchase?: Record<string, unknown>;
    }
  ).RobloxItemPurchase;
  const flow = api?.startDeveloperProductPurchaseFlow;
  if (typeof flow !== 'function') return false;
  flow(options);
  return true;
}

function tryLegacyDeveloperProductPurchase(button: HTMLButtonElement): boolean {
  const w = window as Window & {
    Roblox?: {
      GamePassItemPurchase?: {
        openPurchaseVerificationView?: (button: unknown, itemType: string) => void;
      };
    };
    jQuery?: (element: HTMLElement) => unknown;
    $?: (element: HTMLElement) => unknown;
  };
  const purchase = w.Roblox?.GamePassItemPurchase?.openPurchaseVerificationView;
  const jq = w.jQuery ?? w.$;
  if (typeof purchase !== 'function' || typeof jq !== 'function') return false;
  purchase(jq(button), 'developer-product');
  return true;
}

function showPurchaseMessage(button: HTMLButtonElement, message: string): void {
  const target = button.parentElement?.querySelector('.bp-dev-product-message');
  if (target instanceof HTMLElement) target.textContent = message;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${SECTION_ID} {
      margin-top: 18px;
    }
    #${SECTION_ID} .bp-dev-products-header {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 12px;
    }
    #${SECTION_ID} .bp-dev-products-title {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    #${SECTION_ID} .bp-dev-products-toggle {
      border: 1px solid rgba(255,255,255,0.16);
      border-radius: 6px;
      background: rgba(255,255,255,0.1);
      color: inherit;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      line-height: 1;
      min-height: 28px;
      padding: 0 10px;
    }
    #${SECTION_ID} .bp-dev-products-toggle:hover {
      background: rgba(255,255,255,0.16);
    }
    #${SECTION_ID} .bp-dev-products-list {
      min-height: 205px;
    }
    #${SECTION_ID}.bp-dev-products-collapsed .bp-dev-products-list {
      display: none;
    }
    #${SECTION_ID} .bp-dev-product-thumb {
      display: inline-flex;
      width: 150px;
      height: 150px;
      align-items: center;
      justify-content: center;
      background: rgba(127,127,127,0.12);
    }
    #${SECTION_ID} .bp-dev-product-thumb img {
      width: 150px;
      height: 150px;
      object-fit: cover;
      display: block;
    }
    #${SECTION_ID} .bp-dev-product-placeholder {
      width: 52px;
      height: 52px;
      border-radius: 10px;
      border: 2px solid currentColor;
      opacity: 0.35;
    }
    #${SECTION_ID} .bp-dev-product-message {
      margin-top: 6px;
      font-size: 11px;
      line-height: 1.25;
      opacity: 0.75;
      min-height: 0;
    }
    #${SECTION_ID} .bp-dev-products-empty {
      padding: 10px 0;
      font-size: 13px;
      opacity: 0.75;
    }
  `;
  document.head.appendChild(style);
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}
