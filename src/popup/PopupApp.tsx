import { useEffect, useMemo, useRef, useState } from 'react';
import { getSettings, setSettings } from '@/storage/settingsStore';
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

interface FeatureRow {
  key: BooleanSettingKey;
  label: string;
  summary: string;
  controls?: SelectControl[];
}

const FEATURES: FeatureRow[] = [
  {
    key: 'homepageCleanup',
    label: 'Homepage cleanup',
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
    summary:
      "Tracks how long you spend in each experience (60-second presence polling while the browser is open) and shows the Your Most Played widget on the home page. One switch for tracking and the widget.",
  },
  {
    key: 'showGameBadges',
    label: 'Better Badges',
    summary: 'Replaces game badge lists with ownership, rarity, won-yesterday/ever, and sort/filter controls.',
  },
  {
    key: 'showBadgeRarityColors',
    label: 'Color-code badge rarity',
    summary:
      'Tints the rarity percentage in the Better Badges grid: green for easy, orange/red for medium/hard, gold for insane, purple for impossible. Off = uniform text color.',
  },
  {
    key: 'showGameStoreDevProducts',
    label: 'Show Dev products',
    summary: 'Shows public developer products below Passes on game Store tabs.',
  },
  {
    key: 'showGameSubplaces',
    label: 'Show Subplaces',
    summary:
      'Adds a collapsible Subplaces section above Your private servers, listing other places in the experience with thumbnails and a Play button.',
  },
  {
    key: 'showTotalSpent',
    label: 'Total spent on this experience',
    summary:
      'Reads your purchase history (gamepasses, dev products, private servers) and totals the Robux you have spent on the current experience. First load on a session pulls your transaction history, then caches.',
  },
  {
    key: 'showAccountValue',
    label: 'Profile account value',
    summary:
      'Adds an estimated value card to profiles. Public profiles show collectible RAP; your own profile can also total known Robux purchases from transaction history.',
  },
  {
    key: 'showRobuxCash',
    label: 'Robux to currency converter',
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
    key: 'showProfileNotes',
    label: 'Profile notes & nicknames',
    summary:
      'Adds a private notes card on other users\' profiles where you can record a personal nickname and a free-form note. The nickname appears as a (cosmetic) tag next to that user\'s displayed name across SviBlox surfaces. Stored locally; never sent anywhere.',
  },
  {
    key: 'showThemes',
    label: 'Themes page',
    summary:
      'Adds a "Themes" link to the left navigation that opens the SviBlox themes overlay on /home. Switch built-in presets, mix a custom palette, or upload a background image.',
  },
  {
    key: 'showUhbl',
    label: 'Ultra Hard Badge List (UHBL)',
    summary:
      'Adds a "UHBL" link to the left navigation. Mirrors the community-maintained Ultra Hard Badge List sheet, grouped by difficulty (★ tiers) with per-tier owned counts when signed in.',
  },
];

export function PopupApp() {
  const [settings, setLocal] = useState<Settings | null>(null);
  const [foldersState, setFoldersState] = useState<FoldersState>({
    folders: [],
    selectedFolderId: null,
  });
  const [activeInfo, setActiveInfo] = useState<string | null>(null);

  useEffect(() => {
    void getSettings().then(setLocal);
    void getFolders().then(setFoldersState);
    onFoldersChanged(setFoldersState);
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

  const openOptions = () => chrome.runtime.openOptionsPage();

  return (
    <div className="sv-popup">
      <style>{popupCss}</style>
      <section className="sv-panel">
        <div className="sv-title-row">
          <h1>General Features</h1>
          <button className="sv-options" type="button" onClick={openOptions}>
            Options
          </button>
        </div>

        <div className="sv-feature-list">
          {FEATURES.map((feature) => (
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
                <div className="sv-feature-summary">{feature.summary}</div>
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
          ))}
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

  const usedKeys = new Map<string, string>(); // key -> destId
  for (const [destId, key] of Object.entries(hotkeys)) usedKeys.set(key, destId);

  const submit = async (destId: string, key: string): Promise<void> => {
    const existingKey = hotkeys[destId];
    const conflictDest = usedKeys.get(key);
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
          {entries.map(([destId, key]) => (
            <HotkeyRow
              key={destId}
              destId={destId}
              keyChar={key}
              foldersState={foldersState}
              onRebind={(newKey) => submit(destId, newKey)}
              onDelete={() => remove(destId)}
            />
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
  foldersState,
  onRebind,
  onDelete,
}: {
  destId: string;
  keyChar: string;
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
    </div>
  );
}

function AddHotkeyRow({
  existingDestIds,
  foldersState,
  onSave,
  onCancel,
}: {
  existingDestIds: Set<string>;
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
    </div>
  );
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
  .sv-feature-list {
    margin-top: 12px;
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
    gap: 6px;
    margin-bottom: 8px;
  }
  .sv-hotkey-row {
    display: flex;
    align-items: center;
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
`;
