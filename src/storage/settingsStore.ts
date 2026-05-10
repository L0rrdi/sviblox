import { DEFAULT_SETTINGS, Settings } from '@/types';

const KEY = 'bloxplus.settings';

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.sync.get(KEY);
  const merged = { ...DEFAULT_SETTINGS, ...(result[KEY] ?? {}) } as Settings;
  // Migrate retired rate values.
  const validRates: Settings['robuxCashRate'][] = ['devex', 'regular', 'robloxPlus'];
  if (!validRates.includes(merged.robuxCashRate)) {
    merged.robuxCashRate = DEFAULT_SETTINGS.robuxCashRate;
  }
  return merged;
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.sync.set({ [KEY]: next });
  return next;
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[KEY]) {
      cb({ ...DEFAULT_SETTINGS, ...(changes[KEY].newValue ?? {}) });
    }
  });
}
