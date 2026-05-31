/**
 * On marketplace asset pages (`/catalog/{assetId}/...`), add a small source
 * download panel. The service worker does the cross-origin assetdelivery fetch
 * and starts Chrome downloads for the primary asset plus first-level linked
 * source assets (mesh/texture/surface-appearance maps when exposed).
 */

const ROOT_ID = 'bloxplus-catalog-source-download';
const STYLE_ID = 'bloxplus-catalog-source-download-style';

let renderedFor: number | null = null;
let loadSeq = 0;

interface DownloadResponse {
  ok?: boolean;
  count?: number;
  linkedIds?: number[];
  error?: string;
}

export async function run(): Promise<void> {
  const assetId = parseCatalogAssetId();
  if (!assetId) {
    cleanup();
    return;
  }
  ensureStyle();
  if (renderedFor === assetId && document.getElementById(ROOT_ID)) return;

  const seq = ++loadSeq;
  const path = location.pathname;
  const anchor = await waitFor<HTMLElement>(() => findInsertionAnchor());
  if (!anchor || isStale(seq, path, assetId)) return;

  document.getElementById(ROOT_ID)?.remove();
  renderedFor = assetId;
  anchor.insertAdjacentElement('afterend', renderPanel(assetId));
}

function cleanup(): void {
  document.getElementById(ROOT_ID)?.remove();
  renderedFor = null;
  loadSeq += 1;
}

function parseCatalogAssetId(): number | null {
  const m = location.pathname.match(/^\/catalog\/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function findInsertionAnchor(): HTMLElement | null {
  const bundles = document.getElementById('bloxplus-item-bundles');
  if (bundles instanceof HTMLElement) return bundles;
  const details = document.getElementById('item-details');
  if (details instanceof HTMLElement) return details;
  const info = document.querySelector<HTMLElement>('.shopping-cart.item-details-info-content');
  if (info) return info;
  return null;
}

function isStale(seq: number, path: string, assetId: number): boolean {
  return seq !== loadSeq || location.pathname !== path || parseCatalogAssetId() !== assetId;
}

function renderPanel(assetId: number): HTMLElement {
  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.className = 'bp-catalog-source';
  root.innerHTML = `
    <div class="bp-catalog-source-title">Source files</div>
    <div class="bp-catalog-source-body">
      <button type="button" class="bp-catalog-source-btn" data-bp-source-download>
        Download source
      </button>
      <span class="bp-catalog-source-status" data-bp-source-status></span>
    </div>
  `;

  const button = root.querySelector<HTMLButtonElement>('[data-bp-source-download]');
  const status = root.querySelector<HTMLElement>('[data-bp-source-status]');
  button?.addEventListener('click', async () => {
    if (!button || !status) return;
    button.disabled = true;
    status.textContent = 'Preparing downloads...';
    status.classList.remove('bp-catalog-source-error');
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'bp-download-catalog-source',
        assetId,
        assetName: catalogAssetName(),
      })) as DownloadResponse | undefined;
      if (!response?.ok) {
        throw new Error(response?.error || 'Source download failed');
      }
      const linked = response.linkedIds?.length
        ? ` (${response.linkedIds.length} linked)`
        : '';
      status.textContent = `Started ${response.count ?? 0} download${response.count === 1 ? '' : 's'}${linked}.`;
    } catch (e) {
      status.textContent = String(e instanceof Error ? e.message : e);
      status.classList.add('bp-catalog-source-error');
    } finally {
      button.disabled = false;
    }
  });

  return root;
}

function catalogAssetName(): string {
  const candidates = [
    document.querySelector<HTMLElement>('[data-testid="item-name"]'),
    document.querySelector<HTMLElement>('.item-name-container h1'),
    document.querySelector<HTMLElement>('h1'),
  ];
  const text = candidates
    .map((el) => el?.textContent?.trim())
    .find((name): name is string => Boolean(name));
  return text || 'catalog-asset';
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${ROOT_ID} {
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid rgba(255,255,255,0.12);
    }
    #${ROOT_ID} .bp-catalog-source-title {
      margin-bottom: 8px;
      font-size: 14px;
      font-weight: 700;
      color: inherit;
    }
    #${ROOT_ID} .bp-catalog-source-body {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    #${ROOT_ID} .bp-catalog-source-btn {
      min-height: 32px;
      padding: 6px 12px;
      border: 1px solid rgba(127,127,127,0.22);
      border-radius: 6px;
      background: rgba(127,127,127,0.10);
      color: inherit;
      font: 700 13px/1.2 -apple-system, "Segoe UI", Roboto, sans-serif;
      cursor: pointer;
    }
    #${ROOT_ID} .bp-catalog-source-btn:hover:not(:disabled) {
      background: rgba(127,127,127,0.16);
    }
    #${ROOT_ID} .bp-catalog-source-btn:disabled {
      opacity: 0.55;
      cursor: default;
    }
    #${ROOT_ID} .bp-catalog-source-status {
      font-size: 12px;
      line-height: 1.35;
      opacity: 0.72;
    }
    #${ROOT_ID} .bp-catalog-source-error {
      color: #d9534f;
      opacity: 1;
    }
  `;
  document.head.appendChild(style);
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
