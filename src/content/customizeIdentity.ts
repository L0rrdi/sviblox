/**
 * Pure helpers for identifying customizable elements (left nav items in PR 1)
 * and assigning them stable IDs so persisted edits keep their target across
 * React re-renders. IDs are derived from (surface, anchor href || text) and
 * stamped onto the element as `data-bp-cust-id` once.
 *
 * PR 1 supports left-nav LIs only. Future PRs extend SUPPORTED_SELECTORS for
 * header items.
 */

import { cssEscape } from '@/util/html';

// Roblox redesigned the left nav in 2026 — the modern surface is
// `.left-nav nav ul > li` (Tailwind-flavored utility classes, no semantic
// IDs). Older `.left-col-list` / `.rbx-left-col` markup is kept as a fallback
// in case Roblox A/B-tests the legacy layout.
const SUPPORTED_SELECTORS = [
  '.left-nav nav ul > li',
  '.left-nav ul > li',
  '.left-col-list > li',
  '.rbx-left-col > ul > li',
];

export type CustomizeSurface = 'leftnav';

export interface ResolvedTarget {
  el: HTMLElement;
  id: string;
  surface: CustomizeSurface;
}

export function isCustomizableElement(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  for (const sel of SUPPORTED_SELECTORS) {
    if (el.matches(sel)) return true;
  }
  return false;
}

export function findCustomizableAncestor(el: Element | null): HTMLElement | null {
  let cur: Element | null = el;
  while (cur && cur !== document.body) {
    if (isCustomizableElement(cur)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

export function surfaceOf(el: HTMLElement): CustomizeSurface | null {
  if (el.closest('.left-nav, .left-col-list, .rbx-left-col')) return 'leftnav';
  return null;
}

export function customId(el: HTMLElement): string {
  if (el.dataset.bpCustId) return el.dataset.bpCustId;
  if (el.dataset.bpCustomButtonId) {
    const id = `leftnav::custom-button-${el.dataset.bpCustomButtonId}`;
    el.dataset.bpCustId = id;
    return id;
  }
  const surface = surfaceOf(el) ?? 'unknown';
  const anchor = el.querySelector('a');
  const href = anchor?.getAttribute('href')?.trim() ?? '';
  const text = el.textContent?.trim().slice(0, 40) ?? '';
  const seed = href || text || el.outerHTML.slice(0, 80);
  const id = `${surface}::${djb2(seed)}`;
  el.dataset.bpCustId = id;
  return id;
}

/**
 * Returns a CSS selector that should re-find `el` after a page reload, used
 * as a crash-recovery fallback when `customId` can't relocate the target.
 * Prefer the anchor's href (very stable) then position-in-container.
 */
export function buildFallbackSelector(el: HTMLElement): string {
  const href = el.querySelector('a')?.getAttribute('href');
  if (href) {
    return `${supportedParentSelector(el) ?? 'li'}:has(a[href="${href.replace(/"/g, '\\"')}"])`;
  }
  const parent = el.parentElement;
  if (parent) {
    const idx = Array.from(parent.children).indexOf(el);
    return `${supportedParentSelector(el) ?? 'li'}:nth-child(${idx + 1})`;
  }
  return 'li';
}

function supportedParentSelector(el: HTMLElement): string | null {
  for (const sel of SUPPORTED_SELECTORS) {
    if (el.matches(sel)) return sel;
  }
  return null;
}

/**
 * Tags every currently-mounted customizable element with `data-bp-cust-id`
 * and returns the resolved set. The applier and customize-mode click handler
 * both call this on each pass so a stable id is always available.
 */
export function tagAll(root: ParentNode = document): ResolvedTarget[] {
  const out: ResolvedTarget[] = [];
  const seen = new Set<HTMLElement>();
  for (const sel of SUPPORTED_SELECTORS) {
    for (const el of root.querySelectorAll<HTMLElement>(sel)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const surface = surfaceOf(el);
      if (!surface) continue;
      out.push({ el, id: customId(el), surface });
    }
  }
  return out;
}

/**
 * Find the live element for a given id, preferring an existing
 * `data-bp-cust-id` match and falling back to `fallbackSelector` if provided.
 */
export function resolveById(id: string, fallbackSelector?: string): HTMLElement | null {
  const direct = document.querySelector<HTMLElement>(`[data-bp-cust-id="${cssEscape(id)}"]`);
  if (direct) return direct;
  if (!fallbackSelector) return null;
  try {
    const alt = document.querySelector<HTMLElement>(fallbackSelector);
    if (alt) {
      alt.dataset.bpCustId = id;
      return alt;
    }
  } catch {
    // Selector may be invalid in older browsers (e.g. :has) — drop silently.
  }
  return null;
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

