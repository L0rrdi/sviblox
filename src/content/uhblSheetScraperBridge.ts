/**
 * Isolated-world bridge for the UHBL Google Sheet scraper.
 *
 * The MAIN-world script (uhblSheetScraperMain.ts) can monkey-patch fetch /
 * XHR and extract link annotations, but it can't talk to chrome.runtime.
 * We listen for its window.postMessage emissions and forward them to the
 * service worker, which merges into bloxplus.uhbl.mediaMap.
 *
 * Only matches the specific UHBL sheet ID (see manifest.json).
 */

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if ((data as { source?: unknown }).source !== 'bp-uhbl-scrape') return;
  const map = (data as { map?: unknown }).map;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return;
  // Sanitize: keep only string -> string entries.
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
    if (typeof v === 'string' && v && /^https?:\/\//.test(v)) clean[k] = v;
  }
  if (!Object.keys(clean).length) return;
  // Fire-and-forget. SW listener returns ack but we don't need it.
  chrome.runtime.sendMessage({ type: 'bp-uhbl-scrape-update', map: clean }).catch(() => {});
});
