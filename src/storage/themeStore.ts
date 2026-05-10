import { CustomTheme } from '@/types';

const KEY = 'bloxplus.customTheme';

export async function getCustomTheme(): Promise<CustomTheme> {
  const r = await chrome.storage.local.get(KEY);
  return (r[KEY] as CustomTheme | undefined) ?? {};
}

export async function setCustomTheme(patch: Partial<CustomTheme>): Promise<CustomTheme> {
  const cur = await getCustomTheme();
  const next: CustomTheme = { ...cur, ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function setCustomThemeBackground(backgroundImage: string): Promise<CustomTheme> {
  const cur = await getCustomTheme();
  const next: CustomTheme = { ...cur };
  delete next.backgroundImage;
  next.backgroundImage = backgroundImage;
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function removeCustomThemeBackground(): Promise<CustomTheme> {
  const cur = await getCustomTheme();
  const next: CustomTheme = { ...cur };
  delete next.backgroundImage;
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function clearCustomTheme(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}

export function onCustomThemeChanged(cb: (t: CustomTheme) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) {
      cb((changes[KEY].newValue as CustomTheme | undefined) ?? {});
    }
  });
}
