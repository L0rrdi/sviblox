/**
 * MAIN-world content script registered on the UHBL Google Sheet's edit URL.
 *
 * Why this exists: Google's anonymous `var bootstrapData = ...` only contains
 * cell-link annotations for the first ~94 rows of the sheet. The remaining
 * rows (higher-difficulty UHBL tiers) only arrive later via internal XHRs
 * the sheet's web app makes after page load — XHRs we can't replay from
 * outside the page. So instead we ride along inside the page: monkey-patch
 * fetch + XHR at document_start, capture every response body, scrape URL
 * patterns, pair each non-badge URL with the nearest preceding badge URL
 * (cells emit in column order B→J, so col E's media always sits between
 * col C's badge link and col J's), and post the badge→media URL map to
 * the isolated-world bridge which forwards to the SW. The SW merges into
 * the persistent bloxplus.uhbl.mediaMap. First-write wins so a media URL
 * paired with the right badge in an early response can't be overwritten.
 *
 * Only matches the specific UHBL sheet ID (see manifest.json) so this never
 * activates on any other Google Sheet.
 */

// Bootstrap format (var bootstrapData): "24":"<url>" — raw quotes after the
// outer JSON.parse, escaped quotes if we're regexing the raw HTML.
const LINK_RE = /"24":"((?:[^"\\]|\\.)+)"/g;
const ESCAPED_LINK_RE = /\\"24\\":\\"((?:[^"\\]|\\.)+)\\"/g;
// Streamrows format (the XHR for lazy chunks past the initial viewport):
// HYPERLINK-formula cells emit `"5":[2,"<URL>"]` followed by `"5":[2,"<text>"]`.
// We filter to URLs via the `https?://` prefix baked into the regex.
const STREAM_LINK_RE = /"5":\[2,"(https?:\/\/[^"]+?)"\]/g;
const ESCAPED_STREAM_LINK_RE = /\\"5\\":\[2,\\"(https?:\/\/(?:[^"\\]|\\.)+?)\\"\]/g;
// Catch-all: any double-quoted URL anywhere in the body. Picks up the
// Insert > Link annotations Google encodes differently from HYPERLINK
// formula cells (the col-E media annotation isn't wrapped in `"5":[2,...]`
// for plain Insert > Link cells). Source-order pairing keeps wrong matches
// from contaminating the map. Raw + escaped.
const ANY_QUOTED_URL_RE = /"(https?:\/\/[^"]+?)"/g;
const ESCAPED_ANY_QUOTED_URL_RE = /\\"(https?:\/\/(?:[^"\\]|\\.)+?)\\"/g;
const BADGE_RE = /^https?:\/\/(?:www\.)?roblox\.com\/badges\/(\d+)/;

const PATTERNS: RegExp[] = [
  LINK_RE,
  ESCAPED_LINK_RE,
  STREAM_LINK_RE,
  ESCAPED_STREAM_LINK_RE,
  ANY_QUOTED_URL_RE,
  ESCAPED_ANY_QUOTED_URL_RE,
];

const mediaMap: Record<string, string> = {};
let postScheduled = false;
let lastPostedSize = 0;

function decode(raw: string): string {
  // streamrows responses are JSON-in-JSON, so escapes can be doubled up
  // (`\\u003d` is 2 literal backslashes plus `u003d`, since the inner JSON
  // string gets re-escaped when it's embedded in the outer JSON). Match
  // one or more backslashes for each escape pattern so single (bootstrap)
  // and double (streamrows) layers both collapse correctly.
  return raw
    .replace(/\\+u003d/gi, '=')
    .replace(/\\+u0026/gi, '&')
    .replace(/\\+\//g, '/')
    .replace(/\\+"/g, '"')
    .replace(/\\\\/g, '\\');
}

function ingest(text: string): void {
  if (typeof text !== 'string' || text.length < 20) return;
  if (!text.includes('http')) return;

  // Collect URL matches across all patterns with their source positions, then
  // sort so we process this response in true source order. Cells emit in
  // column order B→J, so col E's media URL is always preceded by col C's
  // badge URL within the same row.
  const matches: Array<{ index: number; raw: string }> = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      matches.push({ index: m.index, raw: m[1] });
    }
  }
  if (!matches.length) return;
  matches.sort((a, b) => a.index - b.index);

  // Dedup by (index, url) — different patterns may match overlapping spans
  // for the same URL (the catch-all and the `"5":[2,...]` pattern can hit
  // the same site).
  const seenAt = new Set<string>();
  let added = 0;
  let lastBadge: number | null = null;
  for (const { index, raw } of matches) {
    const url = decode(raw).replace(/\\+$/, '');
    if (!url.startsWith('http')) continue;
    const dedupKey = `${index}:${url}`;
    if (seenAt.has(dedupKey)) continue;
    seenAt.add(dedupKey);
    const badgeMatch = url.match(BADGE_RE);
    if (badgeMatch) {
      lastBadge = Number(badgeMatch[1]);
      continue;
    }
    if (lastBadge != null) {
      const key = String(lastBadge);
      if (!(key in mediaMap)) {
        mediaMap[key] = url;
        added += 1;
      }
    }
  }
  if (added > 0) schedulePost();
}

function schedulePost(): void {
  if (postScheduled) return;
  postScheduled = true;
  setTimeout(() => {
    postScheduled = false;
    flushPost();
  }, 400);
}

function flushPost(): void {
  const size = Object.keys(mediaMap).length;
  if (size === lastPostedSize || size === 0) return;
  lastPostedSize = size;
  window.postMessage(
    { source: 'bp-uhbl-scrape', kind: 'links', map: { ...mediaMap } },
    location.origin
  );
}

// Patch fetch — captures Google's lazy-chunk XHRs (streamrows etc).
const origFetch = window.fetch;
window.fetch = function patchedFetch(...args: Parameters<typeof fetch>) {
  const p = origFetch.apply(this, args);
  p.then((resp) => {
    try {
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      const isTexty =
        ct.includes('text') ||
        ct.includes('json') ||
        ct.includes('javascript') ||
        ct.includes('xml') ||
        ct === '';
      if (!isTexty) return;
      const clone = resp.clone();
      clone.text().then(ingest).catch(() => {});
    } catch {
      // Body already consumed elsewhere, ignore.
    }
  }).catch(() => {});
  return p;
};

// Patch XHR — the streamrows endpoint actually uses XHR, not fetch.
const origSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function patchedSend(
  this: XMLHttpRequest,
  ...args: Parameters<XMLHttpRequest['send']>
) {
  this.addEventListener('load', () => {
    try {
      const text = this.responseText;
      if (typeof text === 'string') ingest(text);
    } catch {
      // responseType !== '' / 'text' makes responseText throw — ignore.
    }
  });
  return origSend.apply(this, args);
};

// Read the inline bootstrap data once DOM is ready. Same recursive walk as
// src/api/uhblSheet.ts but on the live JSON-parsed object so chunk strings
// already have raw quotes.
function ingestBootstrap(): void {
  const data = (window as unknown as { bootstrapData?: unknown }).bootstrapData;
  if (!data || typeof data !== 'object') return;
  const stack: unknown[] = [data];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      if (node.length === 2 && typeof node[0] === 'number' && typeof node[1] === 'string') {
        ingest(node[1]);
        continue;
      }
      for (const x of node) stack.push(x);
      continue;
    }
    for (const v of Object.values(node as Record<string, unknown>)) stack.push(v);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('readystatechange', () => {
    if (document.readyState === 'interactive' || document.readyState === 'complete') {
      ingestBootstrap();
    }
  });
} else {
  ingestBootstrap();
}

// Late flushes catch any chunks Google streams in after `load`. The SW's
// sync orchestration waits up to ~18s, so these cover the tail of the
// page's lazy-load cycle.
window.addEventListener('load', () => {
  setTimeout(() => {
    ingestBootstrap();
    flushPost();
  }, 5000);
  setTimeout(flushPost, 10_000);
  setTimeout(flushPost, 15_000);
});
