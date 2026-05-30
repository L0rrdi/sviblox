import { useEffect, useMemo, useRef, useState } from 'react';
import { getSettings, onSettingsChanged, setSettings } from '@/storage/settingsStore';
import { clearAllCustomizations } from '@/storage/customizationStore';
import { getFolders, onFoldersChanged, FoldersState, FolderGame } from '@/storage/foldersStore';
import { Settings } from '@/types';
import {
  HOTKEY_DESTINATIONS,
  HOTKEY_DESTINATION_BY_ID,
  isKnownHotkeyDestinationId,
  makeFolderGameHotkeyId,
  normalizeBindableKey,
  parseFolderGameHotkeyId,
} from '@/content/hotkeyDestinations';

type BooleanSettingKey = {
  [K in keyof Settings]: Settings[K] extends boolean ? K : never;
}[keyof Settings];

type StringSettingKey = {
  [K in keyof Settings]: Settings[K] extends string ? K : never;
}[keyof Settings];

interface SelectControl {
  type: 'select';
  key: StringSettingKey;
  label: string;
  options: { value: string; label: string }[];
}

type FeatureCategory = 'home' | 'game' | 'profile' | 'extras';

interface FeatureRow {
  key: BooleanSettingKey;
  label: string;
  summary: string;
  category: FeatureCategory;
  controls?: SelectControl[];
}

const CATEGORY_ORDER: { id: FeatureCategory; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'game', label: 'Game pages' },
  { id: 'profile', label: 'Profiles' },
  { id: 'extras', label: 'Themes & extras' },
];

const FEATURES: FeatureRow[] = [
  {
    key: 'homepageCleanup',
    label: 'Homepage cleanup',
    category: 'home',
    summary:
      "Restyles your Roblox home page: Favorites, My Games, and Folders sections appear after Continue, and Standout / Recommended are grouped under a single collapsible dropdown.",
    controls: [
      {
        type: 'select',
        key: 'foldersFolderSelection',
        label: 'Active folder on reload',
        options: [
          { value: 'previous', label: 'Previously selected folder' },
          { value: 'random', label: 'Random folder each refresh' },
        ],
      },
      {
        type: 'select',
        key: 'foldersGamesSort',
        label: 'Folder games order',
        options: [
          { value: 'most-active', label: 'Most active players first' },
          { value: 'least-active', label: 'Least active players first' },
        ],
      },
    ],
  },
  {
    key: 'playtimeTracker',
    label: 'Playtime Tracker',
    category: 'home',
    summary:
      "Tracks how long you spend in each experience (60-second presence polling while the browser is open) and shows the Your Most Played widget on the home page. One switch for tracking and the widget.",
  },
  {
    key: 'showGameBadges',
    label: 'Better Badges',
    category: 'game',
    summary: 'Replaces game badge lists with ownership, rarity, won-yesterday/ever, and sort/filter controls.',
  },
  {
    key: 'showBadgeRarityColors',
    label: 'Color-code badge rarity',
    category: 'game',
    summary:
      'Tints the rarity percentage in the Better Badges grid: green for easy, orange/red for medium/hard, gold for insane, purple for impossible. Off = uniform text color.',
  },
  {
    key: 'showGameStoreDevProducts',
    label: 'Show Dev products',
    category: 'game',
    summary: 'Shows public developer products below Passes on game Store tabs.',
  },
  {
    key: 'showGameSubplaces',
    label: 'Show Subplaces',
    category: 'game',
    summary:
      'Adds a collapsible Subplaces section above Your private servers, listing other places in the experience with thumbnails and a Play button.',
  },
  {
    key: 'showTotalSpent',
    label: 'Total spent on this experience',
    category: 'game',
    summary:
      'Reads your purchase history (gamepasses, dev products, private servers) and totals the Robux you have spent on the current experience. First load on a session pulls your transaction history, then caches.',
  },
  {
    key: 'showRobuxCash',
    label: 'Robux to currency converter',
    category: 'game',
    summary:
      'Shows a real-money estimate beside every Robux price (gamepasses, dev products, store cards). Pick currency and which Roblox rate to use.',
    controls: [
      {
        type: 'select',
        key: 'robuxCashCurrency',
        label: 'Currency',
        options: [
          { value: 'USD', label: 'US Dollar (USD)' },
          { value: 'GBP', label: 'British Pound (GBP)' },
          { value: 'NOK', label: 'Norwegian Krone (NOK)' },
        ],
      },
      {
        type: 'select',
        key: 'robuxCashRate',
        label: 'Rate',
        options: [
          { value: 'regular', label: 'Regular (purchase)' },
          { value: 'devex', label: 'DevEx (cash-out)' },
          { value: 'robloxPlus', label: 'Roblox+ (Premium, -20% on passes/products)' },
        ],
      },
    ],
  },
  {
    key: 'showAccountValue',
    label: 'Profile account value',
    category: 'profile',
    summary:
      'Adds an estimated value card to profiles. Public profiles show collectible RAP; your own profile can also total known Robux purchases from transaction history.',
  },
  {
    key: 'showAccountAge',
    label: 'Account age pill',
    category: 'profile',
    summary:
      "Adds a pill next to Friends/Followers/Following on profile pages showing the account's age in years and months. Display-only — clicking it does nothing.",
  },
  {
    key: 'showProfileNotes',
    label: 'Profile notes & nicknames',
    category: 'profile',
    summary:
      'Adds a private notes card on other users\' profiles where you can record a personal nickname and a free-form note. The nickname appears as a (cosmetic) tag next to that user\'s displayed name across SviBlox surfaces. Stored locally; never sent anywhere.',
  },
  {
    key: 'showThemes',
    label: 'Themes page',
    category: 'extras',
    summary:
      'Adds a "Themes" link to the left navigation that opens the SviBlox themes overlay on /home. Switch built-in presets, mix a custom palette, or upload a background image.',
  },
  {
    key: 'showUhbl',
    label: 'Ultra Hard Badge List (UHBL)',
    category: 'extras',
    summary:
      'Adds a "UHBL" link to the left navigation. Mirrors the community-maintained Ultra Hard Badge List sheet, grouped by difficulty (★ tiers) with per-tier owned counts when signed in.',
  },
  {
    key: 'showCustomize',
    label: 'Customize mode',
    category: 'extras',
    summary:
      'Adds a "Customize" item to the Roblox header settings menu. Opens an edit overlay where you can rename, hide, or change icons on Roblox nav items. Edits persist across sessions. Turn this off to disable customize mode entirely — your edits stay saved but do not apply until re-enabled.',
  },
];

/**
 * Probe Roblox API connectivity from the popup. One lightweight GET to a
 * known-cheap endpoint (the authenticated-user check, already cached
 * extension-side). Returns 'online' / 'offline' / 'checking'.
 */
function useApiStatus(): 'checking' | 'online' | 'offline' {
  const [status, setStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    const timeout = window.setTimeout(() => ctrl.abort(), 4000);
    fetch('https://users.roblox.com/v1/users/authenticated', {
      credentials: 'include',
      signal: ctrl.signal,
      cache: 'no-store',
    })
      .then((r) => {
        // 200 (signed in) AND 401 (signed out but reachable) both prove the
        // Roblox API is up. Only network failure or timeout → offline.
        if (!cancelled) setStatus(r.ok || r.status === 401 ? 'online' : 'offline');
      })
      .catch(() => {
        if (!cancelled) setStatus('offline');
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, []);
  return status;
}

interface SyncUsage {
  totalBytes: number;
  totalPct: number;
  itemBytes: number;
  itemPct: number;
  /** The higher of totalPct / itemPct — drives the warning threshold. */
  worstPct: number;
}

/**
 * Watches chrome.storage.sync usage. Tracks both total usage (vs 100 KB
 * total quota) and the `bloxplus.settings` item alone (vs the 8 KB
 * per-item quota — the binding constraint, since all our sync data
 * lives in that one object). Either crossing 90% should warn the user
 * before silent write failures start.
 */
function useSyncUsage(): SyncUsage | null {
  const [usage, setUsage] = useState<SyncUsage | null>(null);
  useEffect(() => {
    let cancelled = false;
    const TOTAL_QUOTA = chrome.storage.sync.QUOTA_BYTES ?? 102400;
    const ITEM_QUOTA = chrome.storage.sync.QUOTA_BYTES_PER_ITEM ?? 8192;
    const probe = () => {
      Promise.all([
        chrome.storage.sync.getBytesInUse(null),
        chrome.storage.sync.getBytesInUse('bloxplus.settings'),
      ]).then(([totalBytes, itemBytes]) => {
        if (cancelled) return;
        const totalPct = Math.round((totalBytes / TOTAL_QUOTA) * 100);
        const itemPct = Math.round((itemBytes / ITEM_QUOTA) * 100);
        setUsage({
          totalBytes,
          totalPct,
          itemBytes,
          itemPct,
          worstPct: Math.max(totalPct, itemPct),
        });
      });
    };
    probe();
    chrome.storage.onChanged.addListener(probe);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(probe);
    };
  }, []);
  return usage;
}

function openOptions(hash?: string): void {
  const url = chrome.runtime.getURL('options.html') + (hash ? `#${hash}` : '');
  if (chrome.windows?.create) {
    void chrome.windows.create({
      url,
      type: 'popup',
      width: 1120,
      height: 820,
      focused: true,
    }).catch(() => chrome.runtime.openOptionsPage());
    return;
  }
  chrome.runtime.openOptionsPage();
}

function StatusStrip() {
  const apiStatus = useApiStatus();
  const usage = useSyncUsage();
  const apiClass =
    apiStatus === 'online' ? 'sv-status-ok' :
    apiStatus === 'offline' ? 'sv-status-bad' : 'sv-status-neutral';
  const apiLabel =
    apiStatus === 'online' ? 'Roblox API: connected' :
    apiStatus === 'offline' ? 'Roblox API: unreachable' :
    'Roblox API: checking…';
  const usageClass = !usage ? 'sv-status-neutral' :
    usage.worstPct >= 90 ? 'sv-status-bad' :
    usage.worstPct >= 75 ? 'sv-status-warn' : 'sv-status-ok';
  const usageLabel = usage
    ? `Settings item: ${(usage.itemBytes / 1024).toFixed(1)} / 8 KB (${usage.itemPct}%) · Total sync: ${(usage.totalBytes / 1024).toFixed(1)} / 100 KB (${usage.totalPct}%)`
    : 'Sync storage: checking…';
  return (
    <div className="sv-status-strip">
      <div className={`sv-status-pill ${apiClass}`} title={apiLabel}>
        <span className="sv-status-dot" />
        {apiStatus === 'offline' ? 'Offline' : apiStatus === 'online' ? 'Online' : '…'}
      </div>
      <div className={`sv-status-pill ${usageClass}`} title={usageLabel}>
        Storage {usage ? `${usage.worstPct}%` : '…'}
      </div>
      {usage && usage.worstPct >= 90 && (
        <div className="sv-status-warning" role="alert">
          <div>
            {usage.itemPct >= 90
              ? 'Your settings item is almost at the 8 KB per-item sync limit — new changes may stop saving. Trim unused hotkeys, schedule slots, or custom theme palettes.'
              : 'Sync storage almost full — new settings changes may stop saving. Trim old custom themes or nicknames.'}
          </div>
          <button
            type="button"
            className="sv-status-warning-action"
            onClick={() => openOptions('storage')}
          >
            Open storage manager
          </button>
        </div>
      )}
    </div>
  );
}

export function PopupApp() {
  const [settings, setLocal] = useState<Settings | null>(null);
  const [foldersState, setFoldersState] = useState<FoldersState>({
    folders: [],
    selectedFolderId: null,
  });
  const [activeInfo, setActiveInfo] = useState<string | null>(null);
  const [openCategories, setOpenCategories] = useState<Set<FeatureCategory>>(
    () => new Set(['home'])
  );

  useEffect(() => {
    let cancelled = false;
    void getSettings().then((next) => {
      if (!cancelled) setLocal(next);
    });
    void getFolders().then((next) => {
      if (!cancelled) setFoldersState(next);
    });
    const unsubscribeSettings = onSettingsChanged((next) => {
      if (!cancelled) setLocal(next);
    });
    const unsubscribeFolders = onFoldersChanged((next) => {
      if (!cancelled) setFoldersState(next);
    });
    return () => {
      cancelled = true;
      unsubscribeSettings();
      unsubscribeFolders();
    };
  }, []);

  if (!settings) {
    return (
      <div className="sv-popup sv-popup-loading">
        <style>{popupCss}</style>
        Loading...
      </div>
    );
  }

  const toggle = async (key: BooleanSettingKey) => {
    const next = await setSettings({ [key]: !settings[key] } as Partial<Settings>);
    setLocal(next);
  };

  const setSelect = async (key: StringSettingKey, value: string) => {
    const next = await setSettings({ [key]: value } as Partial<Settings>);
    setLocal(next);
  };

  const renderFeature = (feature: FeatureRow) => (
    <div className="sv-feature-block" key={feature.key}>
      <div className="sv-feature-row">
        <div className="sv-feature-label">
          <span>{feature.label}</span>
          <button
            className="sv-info"
            type="button"
            aria-label={`About ${feature.label}`}
            aria-expanded={activeInfo === feature.key}
            title={feature.summary}
            onClick={() =>
              setActiveInfo(activeInfo === feature.key ? null : feature.key)
            }
          >
            !
          </button>
        </div>
        <button
          className={`sv-switch ${settings[feature.key] ? 'sv-switch-on' : ''}`}
          type="button"
          role="switch"
          aria-checked={settings[feature.key]}
          onClick={() => void toggle(feature.key)}
        >
          <span />
        </button>
      </div>
      {activeInfo === feature.key && (
        <div className="sv-feature-summary">
          {feature.summary}
          {feature.key === 'showCustomize' && (
            <button
              type="button"
              className="sv-feature-action"
              onClick={() => {
                if (
                  confirm(
                    'Reset every customization? This clears all renames, hides, and icons. Cannot be undone.'
                  )
                ) {
                  void clearAllCustomizations();
                }
              }}
            >
              Reset all customizations
            </button>
          )}
        </div>
      )}
      {settings[feature.key] && feature.controls && (
        <div className="sv-feature-controls">
          {feature.controls.map((control) => (
            <label className="sv-control-row" key={control.key}>
              <span className="sv-control-label">{control.label}</span>
              <select
                className="sv-select"
                value={settings[control.key] as string}
                onChange={(e) => void setSelect(control.key, e.target.value)}
              >
                {control.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="sv-popup">
      <style>{popupCss}</style>
      <StatusStrip />
      <section className="sv-panel">
        <div className="sv-title-row">
          <h1>General Features</h1>
          <button className="sv-options" type="button" onClick={() => openOptions()}>
            Advanced options
          </button>
        </div>

        <div className="sv-category-list">
          {CATEGORY_ORDER.map((cat) => {
            const items = FEATURES.filter((f) => f.category === cat.id);
            if (!items.length) return null;
            const enabledCount = items.filter((f) => settings[f.key]).length;
            return (
              <details
                className="sv-category"
                key={cat.id}
                open={openCategories.has(cat.id)}
                onToggle={(e) => {
                  const isOpen = e.currentTarget.open;
                  setOpenCategories((prev) => {
                    const next = new Set(prev);
                    if (isOpen) next.add(cat.id);
                    else next.delete(cat.id);
                    return next;
                  });
                }}
              >
                <summary className="sv-category-summary">
                  <span className="sv-category-name">{cat.label}</span>
                  <span className="sv-category-count">
                    {enabledCount} / {items.length}
                  </span>
                </summary>
                <div className="sv-feature-list">{items.map(renderFeature)}</div>
              </details>
            );
          })}
        </div>
      </section>

      <HotkeySection
        hotkeys={settings.gameHotkeys ?? {}}
        foldersState={foldersState}
        onChange={async (next) => {
          const updated = await setSettings({ gameHotkeys: next });
          setLocal(updated);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hotkey manager
// ---------------------------------------------------------------------------

interface HotkeySectionProps {
  hotkeys: Record<string, string>;
  foldersState: FoldersState;
  onChange: (next: Record<string, string>) => Promise<void> | void;
}

function HotkeySection({ hotkeys, foldersState, onChange }: HotkeySectionProps) {
  const [adding, setAdding] = useState(false);
  const [conflict, setConflict] = useState<{
    destId: string;
    key: string;
    existingDestId: string;
  } | null>(null);

  const entries = useMemo(
    () =>
      Object.entries(hotkeys)
        .filter(([destId]) => isKnownHotkeyDestinationId(destId))
        .sort((a, b) => {
          const ai = HOTKEY_DESTINATIONS.findIndex((d) => d.id === a[0]);
          const bi = HOTKEY_DESTINATIONS.findIndex((d) => d.id === b[0]);
          if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
          return hotkeyLabel(a[0], foldersState).localeCompare(hotkeyLabel(b[0], foldersState));
        }),
    [hotkeys, foldersState]
  );

  const usedKeys = hotkeyUsageMap(hotkeys);
  const conflictByDest = hotkeyConflictMap(hotkeys);
  const groupedEntries = useMemo(
    () => groupHotkeyEntries(entries),
    [entries]
  );

  const submit = async (destId: string, key: string): Promise<void> => {
    const existingKey = hotkeys[destId];
    const conflictDest = usedKeys.get(key)?.find((id) => id !== destId);
    if (conflictDest && conflictDest !== destId) {
      // Defer write until user confirms.
      setConflict({ destId, key, existingDestId: conflictDest });
      return;
    }
    const next = { ...hotkeys, [destId]: key };
    if (existingKey && existingKey !== key) {
      // Implicit — no user-visible conflict, just updating same dest's key.
    }
    await onChange(next);
    setAdding(false);
  };

  const confirmReplace = async (): Promise<void> => {
    if (!conflict) return;
    const next = { ...hotkeys };
    delete next[conflict.existingDestId];
    next[conflict.destId] = conflict.key;
    await onChange(next);
    setConflict(null);
    setAdding(false);
  };

  const cancelConflict = (): void => setConflict(null);

  const remove = async (destId: string): Promise<void> => {
    const next = { ...hotkeys };
    delete next[destId];
    await onChange(next);
  };

  return (
    <section className="sv-panel sv-panel-hotkeys">
      <div className="sv-title-row">
        <h1>Hotkeys</h1>
      </div>
      <p className="sv-hotkey-blurb">
        Single keystroke jumps to a section on the current game page or a site
        page. Hold <kbd>|</kbd> on roblox.com to see the full list overlay.
      </p>

      {entries.length === 0 && !adding && (
        <div className="sv-hotkey-empty">No hotkeys yet.</div>
      )}

      {entries.length > 0 && (
        <div className="sv-hotkey-list">
          {conflictByDest.size > 0 && (
            <div className="sv-hotkey-conflict-summary">
              {conflictByDest.size} hotkey{conflictByDest.size === 1 ? '' : 's'} need attention.
            </div>
          )}
          {groupedEntries.map((group) => (
            <div className="sv-hotkey-group" key={group.id}>
              <div className="sv-hotkey-group-title">{group.label}</div>
              {group.items.map(([destId, key]) => (
                <HotkeyRow
                  key={destId}
                  destId={destId}
                  keyChar={key}
                  conflictText={conflictByDest.get(destId)}
                  foldersState={foldersState}
                  onRebind={(newKey) => submit(destId, newKey)}
                  onDelete={() => remove(destId)}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {conflict ? (
        <ConflictPrompt
          conflict={conflict}
          foldersState={foldersState}
          onConfirm={confirmReplace}
          onCancel={cancelConflict}
        />
      ) : adding ? (
        <AddHotkeyRow
          existingDestIds={new Set(Object.keys(hotkeys))}
          usedKeys={usedKeys}
          foldersState={foldersState}
          onSave={submit}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          className="sv-hotkey-add-btn"
          type="button"
          onClick={() => setAdding(true)}
        >
          + Add hotkey
        </button>
      )}
    </section>
  );
}

function HotkeyRow({
  destId,
  keyChar,
  conflictText,
  foldersState,
  onRebind,
  onDelete,
}: {
  destId: string;
  keyChar: string;
  conflictText?: string;
  foldersState: FoldersState;
  onRebind: (newKey: string) => Promise<void> | void;
  onDelete: () => Promise<void> | void;
}) {
  const [listening, setListening] = useState(false);
  const label = hotkeyLabel(destId, foldersState);

  return (
    <div className="sv-hotkey-row">
      <span className="sv-hotkey-label" title={label}>
        {label}
      </span>
      <KeyButton
        keyChar={keyChar}
        listening={listening}
        onStart={() => setListening(true)}
        onCapture={async (newKey) => {
          setListening(false);
          if (newKey !== keyChar) await onRebind(newKey);
        }}
        onCancel={() => setListening(false)}
      />
      <button
        className="sv-hotkey-del"
        type="button"
        aria-label={`Remove hotkey for ${label}`}
        onClick={() => void onDelete()}
      >
        ×
      </button>
      {conflictText && <div className="sv-hotkey-inline-conflict">{conflictText}</div>}
    </div>
  );
}

function AddHotkeyRow({
  existingDestIds,
  usedKeys,
  foldersState,
  onSave,
  onCancel,
}: {
  existingDestIds: Set<string>;
  usedKeys: Map<string, string[]>;
  foldersState: FoldersState;
  onSave: (destId: string, key: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<'destination' | 'folder-game'>('destination');
  const [destId, setDestId] = useState('');
  const [folderId, setFolderId] = useState('');
  const [gameUniverseId, setGameUniverseId] = useState('');
  const [keyChar, setKeyChar] = useState('');
  const [listening, setListening] = useState(false);
  const folder = foldersState.folders.find((f) => f.id === folderId) ?? null;
  const selectedDestId =
    mode === 'folder-game' && gameUniverseId
      ? makeFolderGameHotkeyId(Number(gameUniverseId))
      : destId;
  const keyConflictDest = keyChar
    ? usedKeys.get(keyChar)?.find((id) => id !== selectedDestId)
    : undefined;

  useEffect(() => {
    if (mode !== 'folder-game') return;
    const firstFolder = foldersState.folders[0];
    if (!folderId || !foldersState.folders.some((f) => f.id === folderId)) {
      setFolderId(firstFolder?.id ?? '');
      setGameUniverseId('');
    }
  }, [folderId, foldersState.folders, mode]);

  useEffect(() => {
    if (mode !== 'folder-game') return;
    if (!folder) {
      setGameUniverseId('');
      return;
    }
    const hasGame = folder.games.some((g) => String(g.universeId) === gameUniverseId);
    if (!hasGame) setGameUniverseId(folder.games[0] ? String(folder.games[0].universeId) : '');
  }, [folder, gameUniverseId, mode]);

  const save = (): void => {
    if (!selectedDestId || !keyChar) return;
    void onSave(selectedDestId, keyChar);
  };

  return (
    <div className="sv-hotkey-add-row">
      <select
        className="sv-select sv-hotkey-add-mode"
        value={mode}
        onChange={(e) => {
          const nextMode = e.target.value as 'destination' | 'folder-game';
          setMode(nextMode);
          setDestId('');
          setFolderId(foldersState.folders[0]?.id ?? '');
          setGameUniverseId('');
        }}
      >
        <option value="destination">Page or section</option>
        <option value="folder-game">Game from folder</option>
      </select>

      {mode === 'destination' ? (
        <select
          className="sv-select sv-hotkey-add-select"
          value={destId}
          onChange={(e) => setDestId(e.target.value)}
        >
          <option value="">Pick a destination...</option>
          {HOTKEY_DESTINATIONS.map((d) => (
            <option key={d.id} value={d.id}>
              {existingDestIds.has(d.id) ? `${d.label} (rebinds)` : d.label}
            </option>
          ))}
        </select>
      ) : (
        <>
          <select
            className="sv-select sv-hotkey-add-folder"
            value={folderId}
            onChange={(e) => {
              setFolderId(e.target.value);
              setGameUniverseId('');
            }}
            disabled={!foldersState.folders.length}
          >
            {foldersState.folders.length ? (
              foldersState.folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} ({f.games.length})
                </option>
              ))
            ) : (
              <option value="">No folders yet</option>
            )}
          </select>
          <select
            className="sv-select sv-hotkey-add-game"
            value={gameUniverseId}
            onChange={(e) => setGameUniverseId(e.target.value)}
            disabled={!folder || !folder.games.length}
          >
            {folder?.games.length ? (
              folder.games.map((game) => {
                const id = makeFolderGameHotkeyId(game.universeId);
                return (
                  <option key={game.universeId} value={game.universeId}>
                    {existingDestIds.has(id)
                      ? `${folderGameName(game)} (rebinds)`
                      : folderGameName(game)}
                  </option>
                );
              })
            ) : (
              <option value="">No games in folder</option>
            )}
          </select>
        </>
      )}

      <div className="sv-hotkey-add-keyslot">
        <KeyButton
          keyChar={keyChar}
          listening={listening}
          onStart={() => setListening(true)}
          onCapture={(key) => {
            setKeyChar(key);
            setListening(false);
          }}
          onCancel={() => setListening(false)}
        />
      </div>
      <button
        className="sv-hotkey-add-save"
        type="button"
        onClick={save}
        disabled={!selectedDestId || !keyChar}
      >
        Save
      </button>
      <button className="sv-hotkey-add-cancel" type="button" onClick={onCancel}>
        Cancel
      </button>
      {keyConflictDest && (
        <div className="sv-hotkey-inline-conflict">
          {keyChar.toUpperCase()} is already bound to {hotkeyLabel(keyConflictDest, foldersState)}.
        </div>
      )}
    </div>
  );
}

function hotkeyUsageMap(hotkeys: Record<string, string>): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const [destId, key] of Object.entries(hotkeys)) {
    if (!key) continue;
    const list = used.get(key) ?? [];
    list.push(destId);
    used.set(key, list);
  }
  return used;
}

function hotkeyConflictMap(hotkeys: Record<string, string>): Map<string, string> {
  const used = hotkeyUsageMap(hotkeys);
  const conflicts = new Map<string, string>();
  for (const [key, destIds] of used) {
    if (destIds.length <= 1) continue;
    for (const destId of destIds) {
      conflicts.set(destId, `${key.toUpperCase()} is also used by another hotkey.`);
    }
  }
  return conflicts;
}

function groupHotkeyEntries(entries: Array<[string, string]>): Array<{
  id: string;
  label: string;
  items: Array<[string, string]>;
}> {
  const groups = [
    { id: 'game', label: 'Game page', items: [] as Array<[string, string]> },
    { id: 'site', label: 'Site', items: [] as Array<[string, string]> },
    { id: 'folder', label: 'Folder games', items: [] as Array<[string, string]> },
  ];
  for (const entry of entries) {
    const [destId] = entry;
    const dest = HOTKEY_DESTINATION_BY_ID.get(destId);
    if (parseFolderGameHotkeyId(destId) !== null) groups[2].items.push(entry);
    else if (dest?.scope === 'site') groups[1].items.push(entry);
    else groups[0].items.push(entry);
  }
  return groups.filter((group) => group.items.length > 0);
}

function hotkeyLabel(destId: string, foldersState: FoldersState): string {
  const staticDest = HOTKEY_DESTINATION_BY_ID.get(destId);
  if (staticDest) return staticDest.label;
  const universeId = parseFolderGameHotkeyId(destId);
  if (universeId === null) return destId;
  for (const folder of foldersState.folders) {
    const game = folder.games.find((g) => g.universeId === universeId);
    if (game) return `Game: ${folderGameName(game)}`;
  }
  return `Game: Universe ${universeId}`;
}

function folderGameName(game: FolderGame): string {
  return game.name || `Universe ${game.universeId}`;
}

function KeyButton({
  keyChar,
  listening,
  onStart,
  onCapture,
  onCancel,
}: {
  keyChar: string;
  listening: boolean;
  onStart: () => void;
  onCapture: (key: string) => void;
  onCancel: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (listening) btnRef.current?.focus();
  }, [listening]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!listening) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
      return;
    }
    const key = normalizeBindableKey(e.nativeEvent);
    if (!key) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    onCapture(key);
  };

  return (
    <button
      ref={btnRef}
      className={`sv-hotkey-key ${listening ? 'sv-hotkey-key-listening' : ''}`}
      type="button"
      onClick={() => (listening ? onCancel() : onStart())}
      onKeyDown={onKeyDown}
      onBlur={() => listening && onCancel()}
      title={
        listening
          ? 'Press any letter or digit (Esc to cancel)'
          : keyChar
            ? `Bound to ${keyChar.toUpperCase()} — click to rebind`
            : 'Click then press a key'
      }
    >
      {listening ? 'Press a key…' : keyChar ? keyChar.toUpperCase() : '—'}
    </button>
  );
}

function ConflictPrompt({
  conflict,
  foldersState,
  onConfirm,
  onCancel,
}: {
  conflict: { destId: string; key: string; existingDestId: string };
  foldersState: FoldersState;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const existingLabel = hotkeyLabel(conflict.existingDestId, foldersState);
  const newLabel = hotkeyLabel(conflict.destId, foldersState);
  return (
    <div className="sv-hotkey-conflict">
      <p>
        <kbd>{conflict.key.toUpperCase()}</kbd> is already bound to{' '}
        <strong>{existingLabel}</strong>. Replace with <strong>{newLabel}</strong>?
      </p>
      <div className="sv-hotkey-conflict-actions">
        <button type="button" onClick={() => void onConfirm()}>
          Replace
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const popupCss = `
  :root {
    color-scheme: dark;
  }
  body {
    background: #30363b;
  }
  .sv-popup {
    width: 520px;
    min-height: 480px;
    box-sizing: border-box;
    padding: 0;
    background: #343a40;
    color: #fff;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 15px;
  }
  .sv-popup-loading {
    padding: 18px;
  }
  .sv-status-strip {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 8px 38px;
    background: rgba(0,0,0,0.18);
    border-bottom: 1px solid rgba(0,0,0,0.25);
    font-size: 11px;
  }
  .sv-status-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 999px;
    border: 1px solid rgba(255,255,255,0.18);
    background: rgba(255,255,255,0.06);
    font-weight: 600;
    letter-spacing: 0.2px;
    white-space: nowrap;
  }
  .sv-status-pill.sv-status-ok    { border-color: rgba(46,178,76,0.45); color: #aff0bf; }
  .sv-status-pill.sv-status-warn  { border-color: rgba(245,190,65,0.45); color: #ffe08a; }
  .sv-status-pill.sv-status-bad   { border-color: rgba(217,83,79,0.55); color: #ff9d99; }
  .sv-status-pill.sv-status-neutral { color: rgba(255,255,255,0.7); }
  .sv-status-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: currentColor;
  }
  .sv-status-warning {
    flex-basis: 100%;
    padding: 6px 10px;
    border-radius: 6px;
    background: rgba(217,83,79,0.16);
    border: 1px solid rgba(217,83,79,0.4);
    color: #ffd1ce;
    font-size: 11px;
    line-height: 1.4;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sv-status-warning-action {
    align-self: flex-start;
    background: rgba(255,255,255,0.10);
    border: 1px solid rgba(255,255,255,0.18);
    color: #fff;
    border-radius: 5px;
    padding: 3px 10px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }
  .sv-status-warning-action:hover {
    background: rgba(255,255,255,0.16);
  }
  .sv-panel {
    min-height: 100%;
    box-sizing: border-box;
    padding: 30px 38px 28px;
    border: 1px solid rgba(0,0,0,0.2);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
  }
  .sv-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }
  .sv-title-row h1 {
    margin: 0;
    font-size: 18px;
    font-weight: 700;
    line-height: 1.25;
    border-bottom: 2px solid #fff;
    padding-bottom: 3px;
    letter-spacing: 0;
  }
  .sv-options {
    border: 0;
    border-radius: 4px;
    background: #258edf;
    color: #fff;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    padding: 7px 10px;
  }
  .sv-options:hover {
    background: #35a1f2;
  }
  .sv-category-list {
    margin-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sv-category {
    border: 1px solid rgba(255,255,255,0.10);
    border-radius: 6px;
    background: rgba(0,0,0,0.12);
    overflow: hidden;
  }
  .sv-category[open] {
    background: rgba(0,0,0,0.18);
  }
  .sv-category-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    cursor: pointer;
    list-style: none;
    user-select: none;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.2px;
    color: rgba(255,255,255,0.92);
  }
  .sv-category-summary::-webkit-details-marker { display: none; }
  .sv-category-summary::before {
    content: '▸';
    display: inline-block;
    margin-right: 8px;
    transition: transform 0.12s ease;
    color: rgba(255,255,255,0.55);
    font-size: 10px;
  }
  .sv-category[open] > .sv-category-summary::before {
    transform: rotate(90deg);
  }
  .sv-category-name {
    flex: 1;
    min-width: 0;
  }
  .sv-category-count {
    font-size: 11px;
    font-weight: 600;
    color: rgba(255,255,255,0.55);
    padding: 2px 7px;
    border-radius: 999px;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.08);
  }
  .sv-feature-list {
    padding: 4px 12px 8px;
  }
  .sv-feature-block {
    margin: 0;
  }
  .sv-feature-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 40px;
    gap: 18px;
  }
  .sv-feature-label {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    line-height: 1.25;
    text-shadow: 0 1px 1px rgba(0,0,0,0.55);
  }
  .sv-info {
    width: 15px;
    height: 15px;
    border-radius: 50%;
    border: 2px solid rgba(255,255,255,0.85);
    background: transparent;
    color: #fff;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 800;
    line-height: 1;
    padding: 0;
    flex: 0 0 auto;
  }
  .sv-info:hover,
  .sv-info[aria-expanded="true"] {
    border-color: #fff;
    background: rgba(255,255,255,0.12);
  }
  .sv-switch {
    width: 50px;
    height: 21px;
    border: 0;
    border-radius: 999px;
    background: #58616a;
    cursor: pointer;
    padding: 0;
    position: relative;
    flex: 0 0 auto;
    transition: background 0.12s ease;
  }
  .sv-switch span {
    width: 21px;
    height: 21px;
    border-radius: 50%;
    background: #f5f5f5;
    box-shadow: 0 1px 3px rgba(0,0,0,0.35);
    position: absolute;
    top: 0;
    left: 0;
    transition: transform 0.12s ease;
  }
  .sv-switch-on {
    background: #1f9be6;
  }
  .sv-switch-on span {
    transform: translateX(29px);
  }
  .sv-feature-summary {
    margin: -2px 62px 8px 0;
    padding: 8px 10px;
    border-left: 2px solid rgba(31,155,230,0.9);
    background: rgba(0,0,0,0.18);
    color: rgba(255,255,255,0.78);
    font-size: 12px;
    line-height: 1.35;
  }
  .sv-feature-action {
    display: inline-block;
    margin-top: 8px;
    padding: 5px 10px;
    font-size: 11px;
    font-weight: 600;
    border-radius: 4px;
    border: 1px solid rgba(217, 83, 79, 0.5);
    background: transparent;
    color: #ff8a85;
    cursor: pointer;
    font-family: inherit;
  }
  .sv-feature-action:hover {
    background: rgba(217, 83, 79, 0.16);
  }
  .sv-feature-controls {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 4px 62px 10px 0;
    padding: 8px 10px;
    border-left: 2px solid rgba(31,155,230,0.4);
    background: rgba(0,0,0,0.12);
  }
  .sv-control-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 12px;
  }
  .sv-control-label {
    color: rgba(255,255,255,0.78);
  }
  .sv-select {
    appearance: none;
    background: #2a2f33;
    color: #fff;
    border: 1px solid rgba(255,255,255,0.2);
    border-radius: 4px;
    font: inherit;
    font-size: 12px;
    padding: 4px 8px;
    min-width: 170px;
    cursor: pointer;
    color-scheme: dark;
  }
  .sv-select option {
    background: #1f252b;
    color: #fff;
  }
  .sv-select:focus {
    outline: 1px solid #1f9be6;
  }
  .sv-panel-hotkeys {
    border-top: 1px solid rgba(255,255,255,0.08);
  }
  .sv-panel-hotkeys .sv-title-row h1 {
    border-bottom: 2px solid #fff;
  }
  .sv-hotkey-blurb {
    margin: 8px 0 12px;
    font-size: 12px;
    color: rgba(255,255,255,0.72);
  }
  .sv-hotkey-blurb kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 3px;
    background: rgba(255,255,255,0.14);
    border: 1px solid rgba(255,255,255,0.22);
    font: 700 11px/1 ui-monospace, SFMono-Regular, Consolas, monospace;
    color: #c5b3ff;
  }
  .sv-hotkey-empty {
    padding: 10px 12px;
    border-radius: 5px;
    background: rgba(255,255,255,0.04);
    color: rgba(255,255,255,0.55);
    font-size: 12px;
    text-align: center;
  }
  .sv-hotkey-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 8px;
  }
  .sv-hotkey-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sv-hotkey-group-title {
    font-size: 11px;
    font-weight: 800;
    color: rgba(255,255,255,0.54);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .sv-hotkey-conflict-summary {
    padding: 7px 9px;
    border-radius: 5px;
    background: rgba(217, 83, 79, 0.12);
    border: 1px solid rgba(217, 83, 79, 0.36);
    color: #ffb1ad;
    font-size: 12px;
    line-height: 1.35;
  }
  .sv-hotkey-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 5px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
  }
  .sv-hotkey-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }
  .sv-hotkey-key {
    min-width: 32px;
    height: 28px;
    padding: 0 8px;
    border-radius: 4px;
    background: rgba(116, 64, 234, 0.18);
    color: #c5b3ff;
    border: 1px solid rgba(116, 64, 234, 0.55);
    font: 700 12px/1 ui-monospace, SFMono-Regular, Consolas, monospace;
    text-transform: uppercase;
    cursor: pointer;
  }
  .sv-hotkey-key:hover {
    background: rgba(116, 64, 234, 0.28);
  }
  .sv-hotkey-key-listening {
    background: #4a90e2;
    color: #fff;
    border-color: #4a90e2;
    text-transform: none;
    font-size: 11px;
    padding: 0 10px;
    animation: sv-hotkey-pulse 1s ease-in-out infinite;
  }
  @keyframes sv-hotkey-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(74, 144, 226, 0.5); }
    50% { box-shadow: 0 0 0 4px rgba(74, 144, 226, 0); }
  }
  .sv-hotkey-del {
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: rgba(255,255,255,0.55);
    font: 700 16px/1 inherit;
    cursor: pointer;
  }
  .sv-hotkey-del:hover {
    background: rgba(217, 83, 79, 0.22);
    color: #fbb;
  }
  .sv-hotkey-add-btn {
    width: 100%;
    padding: 8px 10px;
    border: 1px dashed rgba(255,255,255,0.22);
    border-radius: 5px;
    background: transparent;
    color: rgba(255,255,255,0.78);
    font: 600 12px/1.3 inherit;
    cursor: pointer;
  }
  .sv-hotkey-add-btn:hover {
    background: rgba(255,255,255,0.04);
    color: #fff;
  }
  .sv-hotkey-add-row {
    display: grid;
    grid-template-columns: 120px minmax(0, 1fr) minmax(0, 1fr) auto auto auto;
    align-items: center;
    gap: 6px;
    padding: 8px;
    border-radius: 5px;
    background: rgba(74, 144, 226, 0.08);
    border: 1px solid rgba(74, 144, 226, 0.32);
  }
  .sv-hotkey-add-mode,
  .sv-hotkey-add-folder,
  .sv-hotkey-add-game {
    min-width: 0;
    width: 100%;
  }
  .sv-hotkey-add-select {
    grid-column: span 2;
    min-width: 0;
    width: 100%;
  }
  .sv-hotkey-add-keyslot {
    display: flex;
  }
  .sv-hotkey-add-save,
  .sv-hotkey-add-cancel {
    height: 28px;
    padding: 0 10px;
    border-radius: 4px;
    font: 700 12px/1 inherit;
    cursor: pointer;
    border: 0;
  }
  .sv-hotkey-add-save {
    background: #1f9be6;
    color: #fff;
  }
  .sv-hotkey-add-save:disabled {
    background: rgba(255,255,255,0.10);
    color: rgba(255,255,255,0.45);
    cursor: not-allowed;
  }
  .sv-hotkey-add-cancel {
    background: rgba(255,255,255,0.08);
    color: rgba(255,255,255,0.78);
  }
  .sv-hotkey-conflict {
    padding: 10px 12px;
    border-radius: 5px;
    background: rgba(217, 83, 79, 0.12);
    border: 1px solid rgba(217, 83, 79, 0.40);
    font-size: 12px;
  }
  .sv-hotkey-conflict p {
    margin: 0 0 8px;
  }
  .sv-hotkey-conflict kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 3px;
    background: rgba(255,255,255,0.14);
    border: 1px solid rgba(255,255,255,0.22);
    font: 700 11px/1 ui-monospace, SFMono-Regular, Consolas, monospace;
    color: #fff;
  }
  .sv-hotkey-conflict-actions {
    display: flex;
    gap: 6px;
  }
  .sv-hotkey-conflict-actions button {
    flex: 1;
    height: 28px;
    border-radius: 4px;
    font: 700 12px/1 inherit;
    border: 0;
    cursor: pointer;
  }
  .sv-hotkey-conflict-actions button:first-child {
    background: #d9534f;
    color: #fff;
  }
  .sv-hotkey-conflict-actions button:last-child {
    background: rgba(255,255,255,0.08);
    color: rgba(255,255,255,0.78);
  }
  .sv-hotkey-inline-conflict {
    flex-basis: 100%;
    color: #ffb1ad;
    font-size: 11px;
    line-height: 1.35;
  }
  .sv-panel-backup {
    border-top: 1px solid rgba(255,255,255,0.08);
  }
  .sv-panel-playtime-manager {
    border-top: 1px solid rgba(255,255,255,0.08);
  }
  .sv-playtime-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    cursor: pointer;
    list-style: none;
    font-size: 14px;
    font-weight: 800;
  }
  .sv-playtime-summary::-webkit-details-marker { display: none; }
  .sv-playtime-summary::before {
    content: '▸';
    margin-right: 2px;
    color: rgba(255,255,255,0.55);
    font-size: 10px;
    transition: transform 0.12s ease;
  }
  .sv-panel-playtime-manager[open] .sv-playtime-summary::before {
    transform: rotate(90deg);
  }
  .sv-playtime-summary span:first-child {
    flex: 1;
    min-width: 0;
  }
  .sv-playtime-chip {
    flex: 0 0 auto;
    padding: 2px 7px;
    border-radius: 999px;
    background: rgba(255,255,255,0.07);
    border: 1px solid rgba(255,255,255,0.10);
    color: rgba(255,255,255,0.62);
    font-size: 11px;
    font-weight: 700;
  }
  .sv-playtime-manager-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .sv-playtime-grid,
  .sv-playtime-add {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr);
    gap: 8px;
  }
  .sv-playtime-add {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
    align-items: end;
  }
  .sv-playtime-field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 11px;
    color: rgba(255,255,255,0.62);
  }
  .sv-playtime-field input,
  .sv-playtime-field select {
    height: 30px;
    box-sizing: border-box;
    border-radius: 4px;
    border: 1px solid rgba(255,255,255,0.14);
    background: rgba(0,0,0,0.18);
    color: #fff;
    padding: 0 8px;
    font: 12px/1 inherit;
    min-width: 0;
    color-scheme: dark;
  }
  .sv-playtime-field select,
  .sv-playtime-field select option {
    background: #1f252b;
    color: #fff;
  }
  .sv-playtime-actions,
  .sv-playtime-warning {
    display: flex;
    gap: 8px;
  }
  .sv-playtime-actions button,
  .sv-playtime-add button,
  .sv-playtime-warning button {
    height: 30px;
    padding: 0 10px;
    border-radius: 4px;
    border: 1px solid rgba(255,255,255,0.18);
    background: rgba(255,255,255,0.08);
    color: #fff;
    font: 700 12px/1 inherit;
    cursor: pointer;
  }
  .sv-playtime-actions button:hover,
  .sv-playtime-add button:hover,
  .sv-playtime-warning button:hover {
    background: rgba(255,255,255,0.14);
  }
  .sv-playtime-actions .sv-danger-btn {
    border-color: rgba(217,83,79,0.45);
    color: #ffb1ad;
  }
  .sv-playtime-warning {
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    border-radius: 5px;
    border: 1px solid rgba(245,190,65,0.34);
    background: rgba(245,190,65,0.10);
    color: #ffe08a;
    font-size: 12px;
  }
  .sv-backup-blurb {
    margin: 8px 0 12px;
    font-size: 12px;
    color: rgba(255,255,255,0.72);
  }
  .sv-backup-row {
    display: flex;
    gap: 8px;
  }
  .sv-backup-btn {
    flex: 1;
    height: 32px;
    padding: 0 12px;
    border-radius: 4px;
    border: 1px solid rgba(255,255,255,0.18);
    background: rgba(255,255,255,0.06);
    color: #fff;
    font: 700 12px/1 inherit;
    cursor: pointer;
  }
  .sv-backup-btn:hover {
    background: rgba(255,255,255,0.12);
    border-color: rgba(255,255,255,0.30);
  }
  .sv-backup-status {
    margin-top: 10px;
    padding: 8px 10px;
    border-radius: 5px;
    font-size: 12px;
    line-height: 1.35;
  }
  .sv-backup-status-ok {
    background: rgba(46,178,76,0.14);
    border: 1px solid rgba(46,178,76,0.40);
    color: #aff0bf;
  }
  .sv-backup-status-err {
    background: rgba(217,83,79,0.14);
    border: 1px solid rgba(217,83,79,0.40);
    color: #ffd1ce;
  }
`;
