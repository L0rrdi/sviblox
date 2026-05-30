/**
 * Main-world content script. Reads React fiber data the isolated-world
 * content script can't see (`__reactFiber*` expandos), and copies the
 * relevant fields onto each `<li>` as dataset attributes the isolated
 * script can read via `tile.dataset.*`.
 *
 * Activated only on Roblox game pages. Cheap to install — does nothing
 * until tiles exist or until the isolated script dispatches a sync request.
 */

interface FiberLike {
  memoizedProps?: unknown;
  return?: FiberLike | null;
}

interface ServerInstanceLike {
  id?: unknown;
  ping?: unknown;
  playing?: unknown;
  maxPlayers?: unknown;
}

(() => {
  const w = window as unknown as Record<string, unknown>;
  if (w.__bpFiberBridgeRunning) return;
  w.__bpFiberBridgeRunning = true;

  function findGameInstances(tile: HTMLElement): ServerInstanceLike[] | null {
    const fiberKey = Object.keys(tile).find((k) => k.indexOf('__reactFiber') === 0);
    if (!fiberKey) return null;
    let node = (tile as unknown as Record<string, unknown>)[fiberKey] as FiberLike | null;
    while (node) {
      const p = node.memoizedProps as { gameInstances?: unknown } | null;
      if (p && Array.isArray(p.gameInstances)) {
        return p.gameInstances as ServerInstanceLike[];
      }
      node = node.return ?? null;
    }
    return null;
  }

  function findInstanceId(tile: HTMLElement): string | null {
    const fiberKey = Object.keys(tile).find((k) => k.indexOf('__reactFiber') === 0);
    if (!fiberKey) return null;
    let node = (tile as unknown as Record<string, unknown>)[fiberKey] as FiberLike | null;
    while (node) {
      const p = node.memoizedProps as { id?: unknown } | null;
      if (
        p &&
        typeof p.id === 'string' &&
        /^[0-9a-f]{8}-/i.test(p.id)
      ) {
        return p.id;
      }
      node = node.return ?? null;
    }
    return null;
  }

  function sync(): void {
    const tiles = document.querySelectorAll<HTMLLIElement>(
      'li.rbx-public-game-server-item'
    );
    if (!tiles.length) return;
    const arr = findGameInstances(tiles[0]);
    if (!arr) return;
    const map = new Map<string, ServerInstanceLike>();
    for (const s of arr) {
      if (s && typeof s.id === 'string') map.set(s.id, s);
    }
    for (const t of tiles) {
      const id = findInstanceId(t);
      if (!id) continue;
      const s = map.get(id);
      if (!s) continue;
      t.dataset.bpInstanceId = id;
      if (typeof s.ping === 'number') t.dataset.bpPing = String(s.ping);
      if (typeof s.playing === 'number') t.dataset.bpPlaying = String(s.playing);
      if (typeof s.maxPlayers === 'number') t.dataset.bpMaxPlayers = String(s.maxPlayers);
    }
    document.dispatchEvent(new CustomEvent('bp-fiber-synced'));
  }

  let lastRunAt = 0;
  function safeSync(): void {
    // Light throttle — the isolated script may fire several requests in
    // a row when React rerenders the list.
    const now = Date.now();
    if (now - lastRunAt < 50) return;
    lastRunAt = now;
    try {
      sync();
    } catch {
      /* swallow — caller will retry */
    }
  }

  // Passive: only sync when the isolated-world content script requests it.
  // No MutationObserver here — that fights Roblox's React on heavy pages.
  document.addEventListener('bp-fiber-sync-request', safeSync);

  // Bridge for SviBlox Quick Play buttons. Calls Roblox's matchmaker join
  // directly so the launcher pops up without a full page navigation.
  document.addEventListener('bp-quickplay', (e: Event) => {
    const detail = (e as CustomEvent<{ placeId?: number }>).detail;
    if (!detail || typeof detail.placeId !== 'number') return;
    const launcher = (window as unknown as {
      Roblox?: {
        GameLauncher?: {
          joinMultiplayerGame?: (placeId: number) => void;
        };
      };
    }).Roblox?.GameLauncher;
    if (launcher?.joinMultiplayerGame) {
      try {
        launcher.joinMultiplayerGame(detail.placeId);
        return;
      } catch {
        /* fall through */
      }
    }
    window.location.href = `https://www.roblox.com/games/start?placeId=${detail.placeId}`;
  });

  // Bridge for SviBlox dev-product Buy buttons. The purchase APIs
  // (`RobloxItemPurchase.startDeveloperProductPurchaseFlow` and the legacy
  // `Roblox.GamePassItemPurchase.openPurchaseVerificationView`) live on page
  // globals and are invisible from the isolated content-script world — same
  // reason React fiber expandos are. We dispatch from the isolated world
  // with just a productId and let main world find the button, harvest its
  // data-* attrs, and invoke whichever purchase API exists.
  document.addEventListener('bp-dev-product-purchase', (e: Event) => {
    const detail = (e as CustomEvent<{ productId?: number }>).detail;
    if (!detail || typeof detail.productId !== 'number') return;
    const button = document.querySelector<HTMLButtonElement>(
      `.bp-dev-product-purchase[data-product-id="${detail.productId}"]`
    );
    if (!button) return;

    const w = window as unknown as {
      RobloxItemPurchase?: {
        startDeveloperProductPurchaseFlow?: (opts: unknown) => void;
      };
      Roblox?: {
        GamePassItemPurchase?: {
          openPurchaseVerificationView?: (btn: unknown, itemType: string) => void;
        };
      };
      jQuery?: (el: HTMLElement) => unknown;
      $?: (el: HTMLElement) => unknown;
    };

    const unified = w.RobloxItemPurchase?.startDeveloperProductPurchaseFlow;
    if (typeof unified === 'function') {
      try {
        unified({
          productId: Number(button.dataset.productId || 0),
          developerProductId: Number(button.dataset.itemId || 0),
          assetName: button.dataset.itemName || '',
          expectedPrice: Number(button.dataset.expectedPrice || 0),
          expectedSellerId: Number(button.dataset.expectedSellerId || 0),
          sellerName: button.dataset.sellerName || '',
          imageUrl: button.dataset.imageUrl || '',
        });
        return;
      } catch {
        /* fall through to legacy */
      }
    }

    const legacy = w.Roblox?.GamePassItemPurchase?.openPurchaseVerificationView;
    const jq = w.jQuery ?? w.$;
    if (typeof legacy === 'function' && typeof jq === 'function') {
      try {
        legacy(jq(button), 'developer-product');
        return;
      } catch {
        /* swallow */
      }
    }
  });

  // Bridge for SviBlox custom-tile Join buttons. Roblox's own join URL
  // (`/games/start?placeId=X&gameInstanceId=Y`) drops the instance id in
  // some flows and routes the user to a random server. The launcher API,
  // which Roblox's own Join button uses, respects the instance id.
  document.addEventListener('bp-join-instance', (e: Event) => {
    const detail = (e as CustomEvent<{ placeId?: number; instanceId?: string }>)
      .detail;
    if (!detail || typeof detail.placeId !== 'number' || typeof detail.instanceId !== 'string') {
      return;
    }
    const launcher = (window as unknown as {
      Roblox?: {
        GameLauncher?: {
          joinGameInstance?: (placeId: number, instanceId: string) => void;
        };
      };
    }).Roblox?.GameLauncher;
    if (launcher?.joinGameInstance) {
      try {
        launcher.joinGameInstance(detail.placeId, detail.instanceId);
        return;
      } catch {
        /* fall through to URL fallback */
      }
    }
    // Fallback if the launcher API isn't available — same imperfect URL the
    // isolated content script would use without the bridge.
    window.location.href =
      `https://www.roblox.com/games/start?placeId=${detail.placeId}` +
      `&gameInstanceId=${encodeURIComponent(detail.instanceId)}`;
  });
})();
