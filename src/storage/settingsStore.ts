import { DEFAULT_SETTINGS, Settings } from '@/types';

const KEY = 'bloxplus.settings';
let writeChain: Promise<void> = Promise.resolve();

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.sync.get(KEY);
  const merged = { ...DEFAULT_SETTINGS, ...(result[KEY] ?? {}) } as Settings;
  // Migrate retired rate values.
  const validRates: Settings['robuxCashRate'][] = ['devex', 'regular', 'robloxPlus'];
  if (!validRates.includes(merged.robuxCashRate)) {
    merged.robuxCashRate = DEFAULT_SETTINGS.robuxCashRate;
  }
  if (!['transparent', 'solid'].includes(merged.uhblOverlayBackground)) {
    merged.uhblOverlayBackground = DEFAULT_SETTINGS.uhblOverlayBackground;
  }
  return merged;
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const write = writeChain.then(async () => {
    const current = await getSettings();
    const next = { ...current, ...patch };
    await chrome.storage.sync.set({ [KEY]: next });
    return next;
  });
  writeChain = write.then(() => undefined, () => undefined);
  return write;
}

export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area === 'sync' && changes[KEY]) {
      cb({ ...DEFAULT_SETTINGS, ...(changes[KEY].newValue ?? {}) });
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
