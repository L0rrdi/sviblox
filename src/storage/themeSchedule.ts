import { Settings, ThemeSchedule, ThemeScheduleSlot as ThemeScheduleSlotConfig, UserThemeEntry } from '@/types';

export interface ThemeScheduleResolution {
  slotId: string;
  slotLabel: string;
  themeId: string;
  nextChangeAt: number;
  nextStartsAt: string;
}

const DEFAULT_SLOTS: ThemeScheduleSlotConfig[] = [
  { id: 'morning', label: 'Morning', themeId: 'default', startsAt: '07:00' },
  { id: 'evening', label: 'Evening', themeId: 'dark-blue', startsAt: '19:00' },
];

/** Returns the canonical "freshly installed" theme schedule (disabled, 2 default slots). */
export function getDefaultThemeSchedule(): ThemeSchedule {
  return {
    enabled: false,
    slots: DEFAULT_SLOTS.map((slot) => ({ ...slot })),
  };
}

// Keep in sync with PRESETS in themeInjector.ts. `classic-2016` is dev-only
// (see the comment there); the conditional spread drops it from production
// bundles via Vite tree-shaking so the schedule UI doesn't offer it either.
const BUILT_IN_THEME_CHOICES = [
  { id: 'default', name: 'Default', kind: 'built-in' as const },
  { id: 'dark-blue', name: 'Dark blue', kind: 'built-in' as const },
  { id: 'forest', name: 'Forest', kind: 'built-in' as const },
  ...(import.meta.env.DEV
    ? [{ id: 'classic-2016', name: 'Classic 2016', kind: 'built-in' as const }]
    : []),
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

function defaultSlot(index: number): ThemeScheduleSlotConfig {
  return DEFAULT_SLOTS[index] ?? {
    id: `slot-${index + 1}`,
    label: `Slot ${index + 1}`,
    themeId: 'default',
    startsAt: `${String((7 + index * 6) % 24).padStart(2, '0')}:00`,
  };
}

function legacySlots(schedule: Record<string, unknown>): ThemeScheduleSlotConfig[] {
  return [
    {
      id: 'morning',
      label: 'Morning',
      themeId: typeof schedule.lightThemeId === 'string' ? schedule.lightThemeId : 'default',
      startsAt: typeof schedule.lightStartsAt === 'string' ? schedule.lightStartsAt : '07:00',
    },
    {
      id: 'evening',
      label: 'Evening',
      themeId: typeof schedule.darkThemeId === 'string' ? schedule.darkThemeId : 'dark-blue',
      startsAt: typeof schedule.darkStartsAt === 'string' ? schedule.darkStartsAt : '19:00',
    },
  ];
}

function sanitizeSlotId(value: unknown, index: number, used: Set<string>): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const base = raw.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || `slot-${index + 1}`;
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(id);
  return id;
}

export function sanitizeThemeSchedule(
  schedule: ThemeSchedule,
  userThemes: { entries: Record<string, UserThemeEntry>; order: string[] }
): ThemeSchedule {
  const validIds = new Set(getThemeScheduleChoices(userThemes).map((choice) => choice.id));
  const raw = (schedule && typeof schedule === 'object' ? schedule : {}) as Record<string, unknown>;
  const rawSlots = Array.isArray(raw.slots)
    ? (raw.slots as Record<string, unknown>[])
    : legacySlots(raw);
  const usedIds = new Set<string>();
  const slots = rawSlots.slice(0, 12).map((slot, index) => {
    const fallback = defaultSlot(index);
    const themeId = typeof slot.themeId === 'string' && validIds.has(slot.themeId)
      ? slot.themeId
      : fallback.themeId;
    const startsAt = typeof slot.startsAt === 'string' && parseTimeToMinutes(slot.startsAt) != null
      ? slot.startsAt
      : fallback.startsAt;
    const label = typeof slot.label === 'string' && slot.label.trim()
      ? slot.label.trim().slice(0, 32)
      : fallback.label;
    return {
      id: sanitizeSlotId(slot.id, index, usedIds),
      label,
      themeId: validIds.has(themeId) ? themeId : 'default',
      startsAt,
    };
  });
  while (slots.length < 2) {
    const fallback = defaultSlot(slots.length);
    slots.push({
      ...fallback,
      id: sanitizeSlotId(fallback.id, slots.length, usedIds),
      themeId: validIds.has(fallback.themeId) ? fallback.themeId : 'default',
    });
  }
  return {
    enabled: !!raw.enabled,
    slots,
  };
}

export function resolveThemeSchedule(
  settings: Settings,
  userThemes: { entries: Record<string, UserThemeEntry>; order: string[] },
  now = new Date()
): ThemeScheduleResolution | null {
  const schedule = sanitizeThemeSchedule(settings.themeSchedule, userThemes);
  if (!schedule.enabled) return null;

  const currentMinutes = minutesNow(now);
  const slots = schedule.slots
    .map((slot) => ({ slot, minutes: parseTimeToMinutes(slot.startsAt) ?? 0 }))
    .sort((a, b) => a.minutes - b.minutes);
  let activeIndex = -1;
  for (let i = slots.length - 1; i >= 0; i -= 1) {
    if (slots[i].minutes <= currentMinutes) {
      activeIndex = i;
      break;
    }
  }
  if (activeIndex < 0) activeIndex = slots.length - 1;
  const active = slots[activeIndex];
  const next = slots[(activeIndex + 1) % slots.length];
  return {
    slotId: active.slot.id,
    slotLabel: active.slot.label,
    themeId: active.slot.themeId,
    nextStartsAt: next.slot.startsAt,
    nextChangeAt: nextBoundaryMs(now, currentMinutes, next.minutes),
  };
}
