/**
 * Injects a "Customize" item into Roblox's native header settings dropdown
 * (`#settings-popover-menu`), right after the Settings link. Clicking it
 * sets the hash to `#bloxplus-customize` (entering customize mode in place,
 * regardless of the current path) and closes the dropdown via the
 * settings-icon toggle.
 *
 * Gated by `Settings.showCustomize`. Self-heals across React re-renders
 * because `run()` is called on every dispatch tick and is idempotent
 * (presence check by `data-bp-cust-menu-item`).
 */

import { getSettings } from '@/storage/settingsStore';
import { openCustomizeMode } from './customizeMode';

const ITEM_ID = 'bloxplus-settings-menu-customize';
const MENU_ID = 'settings-popover-menu';

let installed = false;
let pendingRun = false;

export function install(): void {
  if (installed) return;
  installed = true;
  new MutationObserver(() => {
    if (document.getElementById(MENU_ID) || document.getElementById(ITEM_ID)) scheduleRun();
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (!target.closest('#settings-icon, #navbar-settings')) return;
    scheduleRun();
    window.setTimeout(scheduleRun, 50);
  }, true);
}

export function run(): void {
  void runAsync();
}

function scheduleRun(): void {
  if (pendingRun) return;
  pendingRun = true;
  requestAnimationFrame(() => {
    pendingRun = false;
    void runAsync();
  });
}

async function runAsync(): Promise<void> {
  const settings = await getSettings();
  const menu = document.getElementById(MENU_ID);
  if (!menu) return;

  const existing = document.getElementById(ITEM_ID);
  if (!settings.showCustomize) {
    existing?.remove();
    return;
  }
  if (existing && existing.parentElement === menu) return;
  existing?.remove();

  const li = document.createElement('li');
  li.id = ITEM_ID;

  const tmpl = menu.querySelector<HTMLAnchorElement>(':scope > li > a.rbx-menu-item');
  const a = document.createElement('a');
  a.className = tmpl?.className ?? 'rbx-menu-item';
  a.href = '#bloxplus-customize';
  a.textContent = 'Customize';
  a.addEventListener('click', (e) => {
    e.preventDefault();
    openCustomizeMode();
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    // Close the dropdown by toggling the native settings-icon button. The
    // native items close via href navigation; we don't navigate, so we drive
    // the close manually.
    document.getElementById('settings-icon')?.click();
  });
  li.appendChild(a);

  // Slot after the first item ("Settings") to keep related entries together.
  const firstItem = menu.querySelector(':scope > li:first-child');
  if (firstItem) {
    firstItem.insertAdjacentElement('afterend', li);
  } else {
    menu.appendChild(li);
  }
}
