import { getSettings, onSettingsChanged, setSettings } from '@/storage/settingsStore';
import { getUserThemes, onUserThemesChanged } from '@/storage/themeStore';
import { resolveThemeSchedule, sanitizeThemeSchedule } from '@/storage/themeSchedule';

let initialized = false;
let timer: number | null = null;
let applying = false;

function clearTimer(): void {
  if (timer != null) {
    window.clearTimeout(timer);
    timer = null;
  }
}

async function applySchedule(): Promise<void> {
  if (applying) return;
  applying = true;
  try {
    const [settings, userThemes] = await Promise.all([getSettings(), getUserThemes()]);
    const resolution = resolveThemeSchedule(settings, userThemes);
    clearTimer();
    if (!resolution) return;

    const sanitized = sanitizeThemeSchedule(settings.themeSchedule, userThemes);
    const needsSanitize =
      JSON.stringify(sanitized) !== JSON.stringify(settings.themeSchedule);
    const patch: Partial<typeof settings> = {};
    if (settings.themeId !== resolution.themeId) patch.themeId = resolution.themeId;
    if (needsSanitize) patch.themeSchedule = sanitized;
    if (Object.keys(patch).length > 0) await setSettings(patch);

    const delay = Math.max(1000, resolution.nextChangeAt - Date.now() + 1000);
    timer = window.setTimeout(() => void applySchedule(), delay);
  } finally {
    applying = false;
  }
}

export function run(): void {
  if (initialized) return;
  initialized = true;
  onSettingsChanged(() => void applySchedule());
  onUserThemesChanged(() => void applySchedule());
  void applySchedule();
}
