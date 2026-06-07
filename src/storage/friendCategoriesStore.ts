/**
 * User-defined friend categories. Each friend can be sorted into at most one
 * category; a premade "Best friend" category ships built-in. Category list
 * ORDER encodes priority (index 0 = highest), which the home friends rail uses
 * to bump higher-priority friends to the front.
 *
 * Stored in chrome.storage.local under `bloxplus.friendCategories`. Global
 * (keyed by friend userId, not by the signed-in account) — friend ids are
 * globally unique, same rationale as `profileAnnotations`.
 *
 * Module-level cache + change listener + side-effect prime on import so
 * content scripts read synchronously after the initial load (the decorator
 * needs a sync lookup per tile). Same pattern as `profileAnnotations`.
 */

const KEY = 'bloxplus.friendCategories';
const NAME_MAX = 40;
const DESCRIPTION_MAX = 140;
const BEST_FRIEND_ID = 'best-friend';

export interface FriendCategory {
  id: string;
  name: string;
  /** First accent color (hex) used for the tile chip + gradient ring. */
  color: string;
  /** Second accent color (hex) used for the gradient ring. */
  color2: string;
  /** Optional short explanation shown in assignment menus. */
  description?: string;
  /** Numeric priority used when creating categories; higher appears earlier. */
  priority?: number;
  /** Built-in icon id used in popup + assignment menu. */
  icon?: string;
  /** Optional emoji override for the icon. */
  emoji?: string;
  /** Premade categories can't be deleted (but can be renamed/recolored/reordered). */
  builtIn?: boolean;
}

export interface FriendCategoriesState {
  /** Order = priority. Index 0 is the highest priority. */
  categories: FriendCategory[];
  /** friendUserId -> categoryId. */
  assignments: Record<number, string>;
}

function defaultState(): FriendCategoriesState {
  return {
    categories: [
      { id: BEST_FRIEND_ID, name: 'Best friend', color: '#ff5aa5', color2: '#6f55ff', builtIn: true },
    ],
    assignments: {},
  };
}

let cache: FriendCategoriesState = defaultState();
let primed: Promise<void> | null = null;
const subscribers = new Set<(state: FriendCategoriesState) => void>();

export function ensureFriendCategoriesPrimed(): Promise<void> {
  if (!primed) {
    primed = chrome.storage.local.get(KEY).then((result) => {
      cache = normalize(result[KEY]);
    });
  }
  return primed;
}

/** Synchronous snapshot of the cache. Prime first if you need fresh data. */
export function getFriendCategoriesState(): FriendCategoriesState {
  return cache;
}

/** The category a friend is assigned to, or null. Sync read. */
export function getCategoryForFriend(userId: number): FriendCategory | null {
  const id = cache.assignments[userId];
  if (!id) return null;
  return cache.categories.find((c) => c.id === id) ?? null;
}

/**
 * Priority index of a category (0 = highest). Returns -1 when the id is
 * unknown. Sync read — used by the home-rail decorator.
 */
export function getCategoryPriority(categoryId: string): number {
  return cache.categories.findIndex((c) => c.id === categoryId);
}

export async function createCategory(
  name: string,
  color: string,
  color2?: string,
  options: Partial<
    Pick<FriendCategory, 'description' | 'priority' | 'icon' | 'emoji'>
  > = {}
): Promise<FriendCategory> {
  await ensureFriendCategoriesPrimed();
  const primary = normalizeColor(color);
  const category: FriendCategory = {
    id: makeId(),
    name: name.trim().slice(0, NAME_MAX) || 'New category',
    color: primary,
    color2: normalizeColor(color2 ?? derivePartnerColor(primary)),
    description: normalizeDescription(options.description),
    priority: normalizePriority(options.priority),
    icon: normalizeIcon(options.icon),
    emoji: normalizeEmoji(options.emoji),
  };
  const next: FriendCategoriesState = {
    ...cache,
    categories: insertCategoryByPriority(cache.categories, category),
  };
  await commit(next);
  return category;
}

export async function renameCategory(id: string, name: string): Promise<void> {
  await ensureFriendCategoriesPrimed();
  const trimmed = name.trim().slice(0, NAME_MAX);
  if (!trimmed) return;
  await commit({
    ...cache,
    categories: cache.categories.map((c) => (c.id === id ? { ...c, name: trimmed } : c)),
  });
}

export async function setCategoryColor(id: string, color: string): Promise<void> {
  await ensureFriendCategoriesPrimed();
  await commit({
    ...cache,
    categories: cache.categories.map((c) =>
      c.id === id ? { ...c, color: normalizeColor(color) } : c
    ),
  });
}

export async function setCategoryColor2(id: string, color: string): Promise<void> {
  await ensureFriendCategoriesPrimed();
  await commit({
    ...cache,
    categories: cache.categories.map((c) =>
      c.id === id ? { ...c, color2: normalizeColor(color) } : c
    ),
  });
}

export async function deleteCategory(id: string): Promise<void> {
  await ensureFriendCategoriesPrimed();
  const target = cache.categories.find((c) => c.id === id);
  if (!target || target.builtIn) return;
  const assignments: Record<number, string> = {};
  for (const [uid, cid] of Object.entries(cache.assignments)) {
    if (cid !== id) assignments[Number(uid)] = cid;
  }
  await commit({
    categories: cache.categories.filter((c) => c.id !== id),
    assignments,
  });
}

/** Moves a category up (dir -1, higher priority) or down (dir +1) in the list. */
export async function moveCategory(id: string, dir: -1 | 1): Promise<void> {
  await ensureFriendCategoriesPrimed();
  const index = cache.categories.findIndex((c) => c.id === id);
  if (index < 0) return;
  const target = index + dir;
  if (target < 0 || target >= cache.categories.length) return;
  const categories = [...cache.categories];
  [categories[index], categories[target]] = [categories[target], categories[index]];
  await commit({ ...cache, categories });
}

/** Assigns a friend to a category, or removes the assignment when categoryId is null. */
export async function assignFriend(userId: number, categoryId: string | null): Promise<void> {
  await ensureFriendCategoriesPrimed();
  const assignments = { ...cache.assignments };
  if (categoryId && cache.categories.some((c) => c.id === categoryId)) {
    assignments[userId] = categoryId;
  } else {
    delete assignments[userId];
  }
  await commit({ ...cache, assignments });
}

export function onFriendCategoriesChanged(cb: (state: FriendCategoriesState) => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[KEY]) return;
  cache = normalize(changes[KEY].newValue);
  for (const cb of subscribers) {
    try {
      cb(cache);
    } catch (e) {
      console.warn('[SviBlox] friendCategories subscriber threw', e);
    }
  }
});

// Prime on import so the decorator has data by its first tile pass.
void ensureFriendCategoriesPrimed();

async function commit(next: FriendCategoriesState): Promise<void> {
  // Update the cache before awaiting the write so the router's dispatch
  // listener (which fires after the storage write) sees fresh data — same
  // freshness discipline as customizationStore / profileAnnotations.
  cache = next;
  await chrome.storage.local.set({ [KEY]: next });
}

function normalize(raw: unknown): FriendCategoriesState {
  if (!raw || typeof raw !== 'object') return defaultState();
  const obj = raw as Partial<FriendCategoriesState>;
  const categories = Array.isArray(obj.categories)
    ? obj.categories.filter(isCategory)
    : [];
  // Guarantee the built-in Best friend category always exists and stays first
  // unless the user has explicitly reordered it (we only re-seed when missing).
  if (!categories.some((c) => c.id === BEST_FRIEND_ID)) {
    categories.unshift({
      id: BEST_FRIEND_ID,
      name: 'Best friend',
      color: '#ff5aa5',
      color2: '#6f55ff',
      builtIn: true,
    });
  }
  const assignments: Record<number, string> = {};
  const validIds = new Set(categories.map((c) => c.id));
  if (obj.assignments && typeof obj.assignments === 'object') {
    for (const [uid, cid] of Object.entries(obj.assignments)) {
      const n = Number(uid);
      if (Number.isFinite(n) && n > 0 && typeof cid === 'string' && validIds.has(cid)) {
        assignments[n] = cid;
      }
    }
  }
  return { categories, assignments };
}

function isCategory(v: unknown): v is FriendCategory {
  if (
    !!v &&
    typeof v === 'object' &&
    typeof (v as FriendCategory).id === 'string' &&
    typeof (v as FriendCategory).name === 'string' &&
    typeof (v as FriendCategory).color === 'string'
  ) {
    const category = v as FriendCategory;
    category.color = normalizeColor(category.color);
    category.color2 = normalizeColor(category.color2 ?? derivePartnerColor(category.color));
    category.description = normalizeDescription(category.description);
    category.priority = normalizePriority(category.priority);
    category.icon = normalizeIcon(category.icon);
    category.emoji = normalizeEmoji(category.emoji);
    return true;
  }
  return false;
}

function normalizeColor(color: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#5b9dff';
}

function normalizeDescription(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, DESCRIPTION_MAX) : '';
}

function normalizePriority(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(1000, Math.round(n)));
}

function normalizeIcon(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9-]{1,32}$/.test(value) ? value : 'user';
}

function normalizeEmoji(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 12) : '';
}

function insertCategoryByPriority(
  categories: FriendCategory[],
  category: FriendCategory
): FriendCategory[] {
  const next = [...categories];
  const target = category.priority ?? 50;
  const index = next.findIndex((c) => (c.priority ?? 50) < target);
  if (index < 0) next.push(category);
  else next.splice(index, 0, category);
  return next;
}

function derivePartnerColor(hex: string): string {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex((h + 42) % 360, Math.min(100, s + 12), Math.max(34, l - 6));
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const int = parseInt(hex.slice(1), 16);
  const r = ((int >> 16) & 255) / 255;
  const g = ((int >> 8) & 255) / 255;
  const b = (int & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = ((g - b) / d) % 6;
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: l * 100 };
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs((2 * l) / 100 - 1)) * (s / 100);
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l / 100 - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return `#${[r, g, b]
    .map((v) =>
      Math.round((v + m) * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `fc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export const FRIEND_CATEGORY_LIMITS = { nameMax: NAME_MAX, descriptionMax: DESCRIPTION_MAX };
