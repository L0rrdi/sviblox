/**
 * Shared HTML/CSS escape helpers. Previously duplicated across ~15 enhancers
 * with slightly different syntax but identical behavior.
 */

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]!);
}

/** Same escaping rules as `escapeHtml`; named separately so call-sites read clearly. */
export function escapeAttr(s: string): string {
  return escapeHtml(s);
}

export function cssEscape(s: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
