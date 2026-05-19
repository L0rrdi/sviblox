/**
 * On marketplace asset pages (`/catalog/{assetId}/...`), show when the item
 * is included in one or more Roblox bundles. Example: Headless Head belongs
 * to the Headless Horseman bundle.
 */

import { CatalogBundle, getBundlesForAsset } from '@/api/catalogBundles';
import { getBundleThumbnails } from '@/api/thumbnails';

const ROOT_ID = 'bloxplus-item-bundles';
const STYLE_ID = 'bloxplus-item-bundles-style';

let renderedFor: number | null = null;
let renderedHadPanel = false;

export async function run(): Promise<void> {
  const assetId = parseCatalogAssetId();
  if (!assetId) {
    cleanup();
    return;
  }
  ensureStyle();
  if (renderedFor === assetId) {
    if (renderedHadPanel && !document.getElementById(ROOT_ID)) {
      // Roblox re-rendered the item details and dropped our panel; repaint it.
    } else {
      return;
    }
  }

  const anchor = await waitFor<HTMLElement>(() => findInsertionAnchor());
  if (!anchor) return;

  let bundles: CatalogBundle[] = [];
  try {
    bundles = await getBundlesForAsset(assetId);
  } catch {
    return;
  }

  document.getElementById(ROOT_ID)?.remove();
  renderedFor = assetId;
  renderedHadPanel = bundles.length > 0;
  if (!bundles.length) return;

  const thumbs = await getBundleThumbnails(bundles.map((b) => b.id));
  anchor.insertAdjacentElement('afterend', renderBundlePanel(bundles, thumbs));
}

function cleanup(): void {
  document.getElementById(ROOT_ID)?.remove();
  renderedFor = null;
  renderedHadPanel = false;
}

function parseCatalogAssetId(): number | null {
  const m = location.pathname.match(/^\/catalog\/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function findInsertionAnchor(): HTMLElement | null {
  const details = document.getElementById('item-details');
  if (details instanceof HTMLElement) return details;
  const info = document.querySelector<HTMLElement>('.shopping-cart.item-details-info-content');
  if (info) return info;
  return null;
}

function renderBundlePanel(
  bundles: CatalogBundle[],
  thumbnails: Map<number, string>
): HTMLElement {
  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.className = 'bp-item-bundles';

  const title = document.createElement('div');
  title.className = 'bp-item-bundles-title';
  title.textContent = bundles.length === 1 ? 'Part of bundle' : 'Part of bundles';
  root.appendChild(title);

  for (const bundle of bundles) {
    root.appendChild(renderBundleCard(bundle, thumbnails.get(bundle.id)));
  }
  return root;
}

function renderBundleCard(bundle: CatalogBundle, thumbnail?: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'bp-item-bundle-card';
  a.href = `/bundles/${bundle.id}/${slug(bundle.name)}`;

  const image = document.createElement('span');
  image.className = 'bp-item-bundle-thumb';
  if (thumbnail) {
    const img = document.createElement('img');
    img.src = thumbnail;
    img.alt = '';
    img.loading = 'lazy';
    image.appendChild(img);
  }
  a.appendChild(image);

  const body = document.createElement('span');
  body.className = 'bp-item-bundle-body';

  const name = document.createElement('span');
  name.className = 'bp-item-bundle-name';
  name.textContent = bundle.name;
  body.appendChild(name);

  const meta = document.createElement('span');
  meta.className = 'bp-item-bundle-meta';
  meta.textContent = bundleMeta(bundle);
  body.appendChild(meta);

  a.appendChild(body);
  return a;
}

function bundleMeta(bundle: CatalogBundle): string {
  const bits: string[] = [];
  const price = bundle.product?.isFree
    ? 'Free'
    : typeof bundle.product?.priceInRobux === 'number'
      ? `${formatNumber(bundle.product.priceInRobux)} Robux`
      : bundle.product?.noPriceText;
  if (price) bits.push(price);
  const count = bundle.items?.filter((item) => item.type === 'Asset').length ?? 0;
  if (count > 0) bits.push(`${count} item${count === 1 ? '' : 's'}`);
  if (bundle.bundleType) bits.push(bundle.bundleType);
  return bits.join(' · ');
}

function slug(name: string): string {
  return name
    .trim()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'bundle';
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    #${ROOT_ID} {
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid rgba(255,255,255,0.12);
    }
    #${ROOT_ID} .bp-item-bundles-title {
      margin-bottom: 8px;
      font-size: 14px;
      font-weight: 700;
      color: inherit;
    }
    #${ROOT_ID} .bp-item-bundle-card {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px;
      border-radius: 6px;
      color: inherit;
      text-decoration: none;
      background: rgba(127,127,127,0.08);
      border: 1px solid rgba(127,127,127,0.16);
    }
    #${ROOT_ID} .bp-item-bundle-card + .bp-item-bundle-card {
      margin-top: 8px;
    }
    #${ROOT_ID} .bp-item-bundle-card:hover {
      background: rgba(127,127,127,0.14);
      text-decoration: none;
    }
    #${ROOT_ID} .bp-item-bundle-thumb {
      width: 56px;
      height: 56px;
      flex: 0 0 56px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      background: rgba(127,127,127,0.12);
      overflow: hidden;
    }
    #${ROOT_ID} .bp-item-bundle-thumb img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }
    #${ROOT_ID} .bp-item-bundle-body {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
    }
    #${ROOT_ID} .bp-item-bundle-name {
      font-weight: 700;
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #${ROOT_ID} .bp-item-bundle-meta {
      color: inherit;
      opacity: 0.72;
      font-size: 12px;
      line-height: 1.3;
    }
  `;
  document.head.appendChild(s);
}

async function waitFor<T extends Element>(
  probe: () => T | null,
  timeoutMs = 5000
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
