import { Settings, ThemeSchedule, UserThemeEntry } from '@/types';

export type ThemeScheduleSlot = 'light' | 'dark';

export interface ThemeScheduleResolution {
  slot: ThemeScheduleSlot;
  themeId: string;
  nextChangeAt: number;
}

const FALLBACK_BY_SLOT: Record<ThemeScheduleSlot, string> = {
  light: 'default',
  dark: 'dark-blue',
};

const BUILT_IN_THEME_CHOICES = [
  { id: 'default', name: 'Default', kind: 'built-in' as const },
  { id: 'dark-blue', name: 'Dark blue', kind: 'built-in' as const },
  { id: 'forest', name: 'Forest', kind: 'built-in' as const },
  { id: 'classic-2016', name: 'Classic 2016', kind: 'built-in' as const },
];

function parseTimeToMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function minutesNow(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

function isLightSlot(nowMinutes: number, lightStart: number, darkStart: number): boolean {
  if (lightStart === darkStart) return true;
  if (lightStart < darkStart) {
    return nowMinutes >= lightStart && nowMinutes < darkStart;
  }
  return nowMinutes >= lightStart || nowMinutes < darkStart;
}

function nextBoundaryMs(now: Date, currentMinutes: number, targetMinutes: number): number {
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(Math.floor(targetMinutes / 60), targetMinutes % 60, 0, 0);
  if (targetMinutes <= currentMinutes) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

export function getThemeScheduleChoices(userThemes: {
  entries: Record<string, UserThemeEntry>;
  order: string[];
}): Array<{ id: string; name: string; kind: 'built-in' | 'custom' }> {
  const custom = userThemes.order
    .map((id) => userThemes.entries[id])
    .filter((entry): entry is UserThemeEntry => !!entry)
    .map((entry) => ({ id: entry.id, name: entry.name, kind: 'custom' as const }));
  return [...BUILT_IN_THEME_CHOICES, ...custom];
}

export function sanitizeThemeSchedule(
  schedule: ThemeSchedule,
  userThemes: { entries: Record<string, UserThemeEntry>; order: string[] }
): ThemeSchedule {
  const validIds = new Set(getThemeScheduleChoices(userThemes).map((choice) => choice.id));
  return {
    enabled: !!schedule.enabled,
    lightThemeId: validIds.has(schedule.lightThemeId) ? schedule.lightThemeId : FALLBACK_BY_SLOT.light,
    darkThemeId: validIds.has(schedule.darkThemeId) ? schedule.darkThemeId : FALLBACK_BY_SLOT.dark,
    lightStartsAt: parseTimeToMinutes(schedule.lightStartsAt) == null ? '07:00' : schedule.lightStartsAt,
    darkStartsAt: parseTimeToMinutes(schedule.darkStartsAt) == null ? '19:00' : schedule.darkStartsAt,
  };
}

export function resolveThemeSchedule(
  settings: Settings,
  userThemes: { entries: Record<string, UserThemeEntry>; order: string[] },
  now = new Date()
): ThemeScheduleResolution | null {
  const schedule = sanitizeThemeSchedule(settings.themeSchedule, userThemes);
  if (!schedule.enabled) return null;

  const lightStart = parseTimeToMinutes(schedule.lightStartsAt) ?? 7 * 60;
  const darkStart = parseTimeToMinutes(schedule.darkStartsAt) ?? 19 * 60;
  const currentMinutes = minutesNow(now);
  const slot: ThemeScheduleSlot = isLightSlot(currentMinutes, lightStart, darkStart) ? 'light' : 'dark';
  const nextTarget = slot === 'light' ? darkStart : lightStart;
  return {
    slot,
    themeId: slot === 'light' ? schedule.lightThemeId : schedule.darkThemeId,
    nextChangeAt: nextBoundaryMs(now, currentMinutes, nextTarget),
  };
}
