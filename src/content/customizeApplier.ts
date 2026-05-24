/**
 * Always-on enhancer that applies every persisted customize edit (rename,
 * hide, custom icon) on each dispatch tick. Targets are resolved by stable
 * id (`customId`) so React re-renders are absorbed for free — `tagAll()`
 * re-stamps fresh DOM nodes on every pass.
 *
 * Edits intentionally do NOT touch any property themes already own (color,
 * background, opacity); themes and customize never fight over the same CSS
 * surface.
 */

import { getSettings } from '@/storage/settingsStore';
import { cssEscape } from '@/util/html';
import {
  CustomButton,
  ElementEdit,
  getCachedCustomizations,
  getCustomizations,
  onCustomizationsChanged,
} from '@/storage/customizationStore';
import { createAnimatedIconElement, isAnimatedIconPresetId } from './customizeAnimatedIcons';
import { tagAll } from './customizeIdentity';

// Prime the in-memory cache once so synchronous reads work on every tick.
let primed = false;
function prime(): void {
  if (primed) return;
  primed = true;
  void getCustomizations();
  onCustomizationsChanged(() => {
    // No work to do here — the next dispatch tick will re-apply.
  });
  ensureStyle();
}

const STYLE_ID = 'bloxplus-customize-applier-style';
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    img.bp-cust-icon {
      width: 24px; height: 24px;
      flex: 0 0 auto;
      object-fit: contain;
      display: inline-block;
    }
    [data-bp-custom-button-id] > a {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 16px;
      cursor: pointer;
      border-radius: 4px;
      color: inherit;
      text-decoration: none;
    }
    [data-bp-custom-button-id] > a:hover {
      background: rgba(255,255,255,0.06);
    }
    /* Placeholder shown when a custom button has no chosen icon. Was a
     * filled colored square (background: currentColor) which read as a real
     * icon and made users think their button rendered broken. Now a faint
     * dashed circle + centered "+" glyph so it visibly says "add an icon". */
    [data-bp-custom-button-id] .bp-nav-icon {
      width: 24px;
      height: 24px;
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 1px dashed currentColor;
      border-radius: 50%;
      color: inherit;
      opacity: 0.45;
      font: 600 14px/1 inherit;
    }
    [data-bp-custom-button-id] .bp-nav-icon::before {
      content: '+';
      line-height: 1;
    }
    .bp-animated-nav-icon {
      width: 24px;
      height: 24px;
      flex: 0 0 auto;
      display: inline-block;
      color: currentColor;
    }
    .bp-animated-nav-icon * {
      vector-effect: non-scaling-stroke;
    }
    /* Soft-hide: visible-but-faded representation of 'hidden: true' items
     * while in customize mode, so they can be located and un-hidden via the
     * drawer. A subtle strike-through diagonal makes the state obvious. */
    .bp-cust-soft-hidden {
      opacity: 0.30;
      position: relative;
    }
    .bp-cust-soft-hidden::after {
      content: '';
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: repeating-linear-gradient(
        135deg,
        transparent 0 8px,
        rgba(255, 130, 120, 0.18) 8px 9px
      );
    }
    .bp-animated-chart-base {
      transform-box: view-box;
      transform-origin: 4px 19px;
    }
    .bp-animated-chart-line {
      stroke-dasharray: 1;
      stroke-dashoffset: 0;
    }
    a:hover .bp-animated-chart-base {
      animation: bp-chart-base-grow 0.4s ease-out both;
    }
    a:hover .bp-animated-chart-line {
      animation: bp-chart-line-draw 0.6s ease-in-out both;
    }
    .bp-animated-youtube-frame,
    .bp-animated-youtube-play {
      transform-box: fill-box;
      transform-origin: center;
    }
    a:hover .bp-animated-youtube-frame {
      animation: bp-youtube-frame-pop 0.45s ease-out both;
    }
    a:hover .bp-animated-youtube-play {
      animation: bp-youtube-play-pop 0.45s ease-out both;
    }
    .bp-animated-paint-stroke {
      transform-box: fill-box;
      transform-origin: left center;
      transform: scaleX(0);
      opacity: 0;
    }
    .bp-animated-paint-roller {
      transform-box: fill-box;
      transform-origin: 50% 50%;
    }
    a:hover .bp-animated-paint-stroke {
      animation: bp-paint-stroke-paint 0.35s ease-out both;
    }
    a:hover .bp-animated-paint-roller {
      animation: bp-paint-roller-drop 0.35s ease-out both;
    }
    /* Twitch: hover shifts color to the brand purple, eyes blink on a loop,
     * and the chat-bubble path gets an occasional glitch jitter. Source uses
     * Framer Motion + randomized timing; we approximate with CSS keyframes
     * on a long-cycle infinite loop (predictable cadence). */
    .bp-animated-nav-icon-twitch {
      transition: color 0.3s ease, stroke 0.3s ease;
    }
    .bp-animated-twitch-eyes {
      transform-box: fill-box;
      transform-origin: center 60%;
    }
    .bp-animated-twitch-body {
      transform-box: fill-box;
      transform-origin: center;
    }
    a:hover .bp-animated-nav-icon-twitch {
      color: #9146FF;
      stroke: #9146FF;
    }
    a:hover .bp-animated-twitch-eyes {
      animation: bp-twitch-blink 2.6s ease-in-out 0.2s infinite;
    }
    a:hover .bp-animated-twitch-body {
      animation: bp-twitch-glitch 3.4s linear 0.6s infinite;
    }
    @keyframes bp-chart-base-grow {
      from { transform: scaleX(0); }
      to { transform: scaleX(1); }
    }
    @keyframes bp-chart-line-draw {
      from { stroke-dashoffset: 1; }
      to { stroke-dashoffset: 0; }
    }
    @keyframes bp-youtube-frame-pop {
      0% { transform: scale(1); }
      45% { transform: scale(1.08); }
      100% { transform: scale(1); }
    }
    @keyframes bp-youtube-play-pop {
      0% { transform: scale(1); opacity: 0.78; }
      45% { transform: scale(1.28); opacity: 1; }
      100% { transform: scale(1); opacity: 1; }
    }
    @keyframes bp-paint-stroke-paint {
      from { transform: scaleX(0); opacity: 0; }
      to   { transform: scaleX(1); opacity: 1; }
    }
    @keyframes bp-paint-roller-drop {
      from { transform: translateY(0) rotate(0deg); }
      to   { transform: translateY(4px) rotate(12deg); }
    }
    /* Twitch eye blink: tiny snap closed near the end of each cycle so it
     * feels like a natural blink with idle time in between. */
    @keyframes bp-twitch-blink {
      0%, 92%, 100% { transform: scaleY(1); }
      94%           { transform: scaleY(0); }
      96%           { transform: scaleY(1); }
    }
    /* Twitch body glitch: brief x/y jitter at two points per cycle, mostly
     * still otherwise — approximates the source's random "rare sharp shift". */
    @keyframes bp-twitch-glitch {
      0%, 100% { transform: translate(0, 0); }
      45%      { transform: translate(0, 0); }
      46%      { transform: translate(-1px, 0.5px); }
      47%      { transform: translate(1px, -0.5px); }
      48%      { transform: translate(0, 0); }
      82%      { transform: translate(0, 0); }
      83%      { transform: translate(1px, 0.5px); }
      84%      { transform: translate(-1px, -0.5px); }
      85%      { transform: translate(0, 0); }
    }
  `;
  document.head.appendChild(style);
}

export function run(): void {
  prime();
  void runAsync();
}

async function runAsync(): Promise<void> {
  const settings = await getSettings();
  if (!settings.showCustomize) {
    // Master switch off — drop everything we've touched.
    restoreAll();
    return;
  }
  // Soft-hide is a customize-mode-only affordance — outside the mode,
  // `hidden` always means `display: none`.
  const inCustomizeMode = location.hash.replace(/^#/, '') === 'bloxplus-customize';
  const softHide = inCustomizeMode && settings.customizeShowHiddenInMode !== false;
  const spec = getCachedCustomizations();
  syncCustomButtons(spec.customButtons ?? []);
  let targets = tagAll();
  // applyOrder rearranges children but does not change membership — the
  // `targets` array's elements are still the same HTMLElements after the
  // reorder, just in a different DOM order. Only retag when applyOrder
  // signals it actually mutated the parent (signals via the boolean return).
  const reordered = applyOrder(targets, spec.leftNavOrder);
  if (reordered) targets = tagAll();
  for (const target of targets) {
    const edit: ElementEdit | undefined = spec.entries[target.id];
    applyHidden(target.el, edit?.hidden, softHide);
    applyText(target.el, cleanTextForTarget(target.el, edit?.text));
    // Custom buttons own their icon state on the CustomButton record and are
    // hydrated by syncCustomButtons above. Skip applyIcon for them — otherwise
    // the (undefined, undefined) lookup here would nuke the icon we just placed.
    if (!target.el.dataset.bpCustomButtonId) {
      applyIcon(target.el, edit?.iconDataUrl, edit?.iconPreset);
    }
  }
}

function cleanTextForTarget(li: HTMLElement, text: string | undefined): string | undefined {
  if (!text) return undefined;
  if (li.dataset.bpCustomButtonId && text.startsWith('leftnav::custom-button-')) return undefined;
  return text;
}

/**
 * Returns true if at least one parent had its children reordered. The applier
 * uses this signal to skip a redundant second `tagAll()` when nothing moved.
 */
function applyOrder(targets: ReturnType<typeof tagAll>, order: string[] | undefined): boolean {
  if (!order?.length) return false;
  const rank = new Map(order.map((id, i) => [id, i]));
  const byParent = new Map<HTMLElement, typeof targets>();
  for (const target of targets) {
    const parent = target.el.parentElement;
    if (!(parent instanceof HTMLElement)) continue;
    const group = byParent.get(parent) ?? [];
    group.push(target);
    byParent.set(parent, group);
  }

  let mutated = false;
  for (const [parent, group] of byParent) {
    const sorted = [...group].sort((a, b) => {
      const ar = rank.get(a.id);
      const br = rank.get(b.id);
      if (ar !== undefined && br !== undefined) return ar - br;
      if (ar !== undefined) return -1;
      if (br !== undefined) return 1;
      return group.indexOf(a) - group.indexOf(b);
    });
    if (sorted.every((target, i) => target.el === group[i].el)) continue;
    for (const target of sorted) parent.appendChild(target.el);
    mutated = true;
  }
  return mutated;
}

function syncCustomButtons(buttons: CustomButton[]): void {
  const parent = findLeftNavList();
  if (!parent) return;
  const wanted = new Set(buttons.map((button) => button.id));
  for (const li of document.querySelectorAll<HTMLElement>('[data-bp-custom-button-id]')) {
    if (!wanted.has(li.dataset.bpCustomButtonId ?? '')) li.remove();
  }
  for (const button of buttons) {
    const selector = `[data-bp-custom-button-id="${cssEscape(button.id)}"]`;
    const existing = document.querySelector<HTMLElement>(selector);
    if (existing) {
      hydrateCustomButton(existing, button);
      if (existing.parentElement !== parent) parent.appendChild(existing);
      continue;
    }
    const item = document.createElement('li');
    hydrateCustomButton(item, button);
    parent.appendChild(item);
  }
}

function findLeftNavList(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('.left-nav nav ul') ??
    document.querySelector<HTMLElement>('.left-nav ul') ??
    document.querySelector<HTMLElement>('.left-col-list') ??
    document.querySelector<HTMLElement>('.rbx-left-col > ul')
  );
}

function hydrateCustomButton(li: HTMLElement, button: CustomButton): void {
  li.id = `bloxplus-custom-nav-${button.id}`;
  li.dataset.bpCustomButtonId = button.id;
  li.dataset.bpCustId = `leftnav::custom-button-${button.id}`;

  let anchor = li.querySelector<HTMLAnchorElement>(':scope > a');
  if (!anchor) {
    li.textContent = '';
    anchor = document.createElement('a');
    li.appendChild(anchor);
  }
  if (anchor.getAttribute('href') !== button.url) anchor.setAttribute('href', button.url);
  if (anchor.getAttribute('aria-label') !== button.label) anchor.setAttribute('aria-label', button.label);

  let label = anchor.querySelector<HTMLSpanElement>(':scope > span.text-truncate-end.text-no-wrap:not(.bp-nav-icon)');
  const iconNodes = [...anchor.querySelectorAll<Element>(':scope > .bp-cust-icon, :scope > .bp-nav-icon, :scope > .bp-animated-nav-icon')];

  let icon: Element;
  if (isAnimatedIconPresetId(button.iconPreset)) {
    const existing = iconNodes.find((node) =>
      node instanceof SVGSVGElement &&
      node.classList.contains('bp-animated-nav-icon') &&
      node.dataset.bpAnimatedIcon === button.iconPreset
    );
    icon = existing ?? createAnimatedIconElement(button.iconPreset);
    for (const node of iconNodes) {
      if (node !== icon) node.remove();
    }
  } else if (button.iconDataUrl) {
    const existing = iconNodes.find((node): node is HTMLImageElement =>
      node instanceof HTMLImageElement && node.classList.contains('bp-cust-icon')
    );
    icon = existing ?? document.createElement('img');
    icon.className = 'bp-cust-icon';
    (icon as HTMLImageElement).alt = '';
    if ((icon as HTMLImageElement).src !== button.iconDataUrl) (icon as HTMLImageElement).src = button.iconDataUrl;
    for (const node of iconNodes) {
      if (node !== icon) node.remove();
    }
  } else {
    const existing = iconNodes.find((node) =>
      node instanceof HTMLSpanElement && node.classList.contains('bp-nav-icon')
    );
    icon = existing ?? document.createElement('span');
    icon.className = 'bp-nav-icon';
    icon.setAttribute('aria-hidden', 'true');
    for (const node of iconNodes) {
      if (node !== icon) node.remove();
    }
  }

  if (!label) {
    label = document.createElement('span');
    label.className = 'text-truncate-end text-no-wrap';
  }
  if (icon.parentElement !== anchor) {
    anchor.insertBefore(icon, anchor.firstChild);
  } else if (anchor.firstElementChild !== icon) {
    anchor.insertBefore(icon, anchor.firstElementChild);
  }
  if (label.parentElement !== anchor || label.previousElementSibling !== icon) {
    icon.insertAdjacentElement('afterend', label);
  }
  if (label.textContent !== button.label) label.textContent = button.label;
}

function applyHidden(li: HTMLElement, hidden: boolean | undefined, softHide: boolean): void {
  if (hidden) {
    if (softHide) {
      // Visible at low opacity — user can still click it to un-hide.
      if (li.dataset.bpCustHidden) {
        li.style.display = '';
        delete li.dataset.bpCustHidden;
      }
      li.classList.add('bp-cust-soft-hidden');
    } else {
      li.classList.remove('bp-cust-soft-hidden');
      if (!li.dataset.bpCustHidden) {
        li.dataset.bpCustHidden = '1';
        li.style.display = 'none';
      }
    }
  } else {
    li.classList.remove('bp-cust-soft-hidden');
    if (li.dataset.bpCustHidden) {
      li.style.display = '';
      delete li.dataset.bpCustHidden;
    }
  }
}

function findLabel(li: HTMLElement): HTMLElement | null {
  const a = li.querySelector('a');
  if (!a) return null;
  // Modern Roblox nav: label sits in `span.text-truncate-end` next to the
  // icon-container span. Legacy nav used `.text-nav` / `.font-header-2`.
  // SviBlox-injected entries use plain `span` children. Fall back to the
  // last text-bearing span if none of the known classes match.
  const direct =
    a.querySelector<HTMLElement>(':scope > span.text-truncate-end') ??
    a.querySelector<HTMLElement>(':scope > .min-width-0') ??
    a.querySelector<HTMLElement>('.text-nav') ??
    a.querySelector<HTMLElement>('.font-header-2');
  if (direct) return direct;
  // Generic fallback: the last <span> direct child of <a> with text content.
  const spans = [...a.querySelectorAll<HTMLElement>(':scope > span')].reverse();
  return spans.find((s) => (s.textContent ?? '').trim().length > 0) ?? null;
}

function applyText(li: HTMLElement, text: string | undefined): void {
  const label = findLabel(li);
  if (!label) return;
  if (text) {
    if (label.dataset.bpCustOrigText === undefined) {
      label.dataset.bpCustOrigText = label.textContent ?? '';
    }
    if (label.textContent !== text) label.textContent = text;
  } else if (label.dataset.bpCustOrigText !== undefined) {
    // Rename was cleared — restore the snapshot.
    label.textContent = label.dataset.bpCustOrigText;
    delete label.dataset.bpCustOrigText;
  }
}

function applyIcon(li: HTMLElement, iconUrl: string | undefined, iconPreset: string | undefined): void {
  const anchor = li.querySelector('a');
  if (!anchor) return;
  let custIcon = anchor.querySelector<HTMLImageElement>(':scope > img.bp-cust-icon');
  let animatedIcon = anchor.querySelector<SVGSVGElement>(':scope > svg.bp-animated-nav-icon');
  const native = anchor.querySelector<HTMLElement>(
    ':scope > span.size-1000, :scope > svg:not(.bp-animated-nav-icon), :scope > img:not(.bp-cust-icon), :scope > .bp-nav-icon, :scope > [class*="icon" i]:not(.bp-animated-nav-icon)'
  );
  if (isAnimatedIconPresetId(iconPreset)) {
    if (custIcon) {
      custIcon.remove();
      custIcon = null;
    }
    if (!animatedIcon || animatedIcon.dataset.bpAnimatedIcon !== iconPreset) {
      animatedIcon?.remove();
      animatedIcon = createAnimatedIconElement(iconPreset);
    }
    if (native && !native.classList.contains('bp-animated-nav-icon')) {
      native.dataset.bpCustHiddenIcon = '1';
      native.style.display = 'none';
      if (animatedIcon.parentElement !== native.parentElement || animatedIcon.nextElementSibling !== native) {
        native.parentElement?.insertBefore(animatedIcon, native);
      }
    } else if (animatedIcon.parentElement !== anchor) {
      anchor.insertBefore(animatedIcon, anchor.firstChild);
    }
  } else if (iconUrl) {
    if (animatedIcon) animatedIcon.remove();
    if (!custIcon) {
      // Modern Roblox: icon lives inside `span.size-1000` (the 32px icon
      // slot). Legacy / SviBlox-injected items use a direct svg/img/masked
      // span instead. Either way, we hide the native node and inject our img
      // at the same DOM position so layout stays put.
      custIcon = document.createElement('img');
      custIcon.className = 'bp-cust-icon';
      custIcon.alt = '';
      if (native && !native.classList.contains('bp-cust-icon')) {
        native.dataset.bpCustHiddenIcon = '1';
        native.style.display = 'none';
        native.parentElement?.insertBefore(custIcon, native);
      } else {
        anchor.insertBefore(custIcon, anchor.firstChild);
      }
    }
    if (custIcon.src !== iconUrl) custIcon.src = iconUrl;
  } else {
    if (custIcon) custIcon.remove();
    if (animatedIcon) animatedIcon.remove();
    const native = anchor.querySelector<HTMLElement>(':scope > [data-bp-cust-hidden-icon]');
    if (native) {
      native.style.display = '';
      delete native.dataset.bpCustHiddenIcon;
    }
  }
}

function restoreAll(): void {
  for (const li of document.querySelectorAll<HTMLElement>('[data-bp-cust-hidden]')) {
    li.style.display = '';
    delete li.dataset.bpCustHidden;
  }
  for (const li of document.querySelectorAll<HTMLElement>('.bp-cust-soft-hidden')) {
    li.classList.remove('bp-cust-soft-hidden');
  }
  for (const lbl of document.querySelectorAll<HTMLElement>('[data-bp-cust-orig-text]')) {
    lbl.textContent = lbl.dataset.bpCustOrigText ?? '';
    delete lbl.dataset.bpCustOrigText;
  }
  for (const img of document.querySelectorAll('img.bp-cust-icon')) img.remove();
  for (const native of document.querySelectorAll<HTMLElement>('[data-bp-cust-hidden-icon]')) {
    native.style.display = '';
    delete native.dataset.bpCustHiddenIcon;
  }
  for (const li of document.querySelectorAll<HTMLElement>('[data-bp-custom-button-id]')) li.remove();
}

