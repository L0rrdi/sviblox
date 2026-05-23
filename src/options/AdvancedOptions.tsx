import { useEffect, useMemo, useRef, useState } from 'react';
import { getGameInfo } from '@/api/games';
import { getPlaytime, setPlaytime } from '@/storage/playtimeStore';
import { GamePlaytimeEntry } from '@/types';

const BACKUP_LOCAL_KEYS = [
  'bloxplus.customizations',
  'bloxplus.folders',
  'bloxplus.lastSeen',
  'bloxplus.profileAnnotations',
  'bloxplus.customTheme',
  'bloxplus.userThemes',
] as const;

const BACKUP_SYNC_KEYS = ['bloxplus.settings'] as const;
const PLAYTIME_BACKUP_KEY = 'bloxplus.playtime';
const LAST_PRE_IMPORT_BACKUP_KEY = 'bloxplus.lastPreImportBackup';

interface BackupFile {
  version: 1;
  exportedAt: string;
  sync: Record<string, unknown>;
  local: Record<string, unknown>;
}

type BackupKind = 'settings' | 'playtime';

interface StoredPreImportBackup {
  kind: BackupKind;
  label: string;
  savedAt: string;
  file: BackupFile;
}

interface PendingImport {
  kind: BackupKind;
  file: BackupFile;
  summary: string[];
}

type SortMode = 'time-desc' | 'name' | 'recent';

export function AdvancedOptions() {
  const scrollToSection = (id: string): void => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="adv-page">
      <style>{advancedCss}</style>
      <aside className="adv-sidebar">
        <div className="adv-brand">SviBlox</div>
        <button className="adv-nav-button" type="button" onClick={() => scrollToSection('data')}>
          Data & backups
        </button>
        <button className="adv-nav-button" type="button" onClick={() => scrollToSection('playtime')}>
          Playtime manager
        </button>
        <button className="adv-nav-button" type="button" onClick={() => scrollToSection('help')}>
          Notes
        </button>
      </aside>
      <main className="adv-main">
        <header className="adv-hero">
          <p>Local extension tools</p>
          <h1>Advanced Options</h1>
        </header>
        <DataBackups />
        <PlaytimeManager />
        <section id="help" className="adv-card">
          <h2>Notes</h2>
          <p>
            These tools write directly to Chrome extension storage on this machine. Imports create a
            pre-import restore point before overwriting anything.
          </p>
        </section>
      </main>
    </div>
  );
}

function DataBackups() {
  const settingsFileRef = useRef<HTMLInputElement>(null);
  const playtimeFileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [restore, setRestore] = useState<StoredPreImportBackup | null>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refreshRestore = async (): Promise<void> => {
    const raw = await chrome.storage.local.get(LAST_PRE_IMPORT_BACKUP_KEY);
    setRestore((raw[LAST_PRE_IMPORT_BACKUP_KEY] as StoredPreImportBackup | undefined) ?? null);
  };

  useEffect(() => {
    void refreshRestore();
  }, []);

  const exportSettings = async (): Promise<void> => {
    downloadBackup(await buildBackup(), 'sviblox-backup');
    setStatus({ kind: 'ok', text: 'Settings backup exported.' });
  };

  const exportPlaytime = async (): Promise<void> => {
    downloadBackup(await buildPlaytimeBackup(), 'sviblox-playtime');
    setStatus({ kind: 'ok', text: 'Playtime backup exported.' });
  };

  const readImportFile = async (kind: PendingImport['kind'], file: File): Promise<void> => {
    try {
      const text = await file.text();
      const parsed = kind === 'settings' ? parseBackup(text) : parsePlaytimeBackup(text);
      setPending({
        kind,
        file: parsed,
        summary: kind === 'settings' ? summarizeSettingsBackup(parsed) : summarizePlaytimeBackup(parsed),
      });
      setStatus(null);
    } catch (err) {
      setStatus({ kind: 'err', text: `Import preview failed: ${(err as Error).message}` });
    }
  };

  const applyPending = async (): Promise<void> => {
    if (!pending) return;
    const current = pending.kind === 'settings' ? await buildBackup() : await buildPlaytimeBackup();
    await savePreImportBackup(pending.kind, current);
    downloadBackup(current, `sviblox-pre-import-${pending.kind}`);
    await applyBackup(pending.file, pending.kind);
    setPending(null);
    await refreshRestore();
    setStatus({
      kind: 'ok',
      text: `${pending.kind === 'settings' ? 'Settings' : 'Playtime'} imported. A pre-import backup was downloaded and saved for restore.`,
    });
  };

  const restorePrevious = async (): Promise<void> => {
    if (!restore) return;
    if (!confirm(`Restore ${restore.label} from ${new Date(restore.savedAt).toLocaleString()}?`)) return;
    await applyBackup(restore.file, restore.kind ?? inferBackupKind(restore.file));
    setStatus({ kind: 'ok', text: 'Pre-import backup restored.' });
  };

  return (
    <section id="data" className="adv-card">
      <div className="adv-card-head">
        <div>
          <h2>Data & backups</h2>
          <p>Export, preview, import, and restore SviBlox storage.</p>
        </div>
      </div>

      <div className="adv-two">
        <div className="adv-tool">
          <h3>Settings backup</h3>
          <p>Themes, folders, customizations, nicknames, hotkeys, and settings. Playtime is separate.</p>
          <div className="adv-actions">
            <button onClick={() => void exportSettings()}>Export settings</button>
            <button onClick={() => settingsFileRef.current?.click()}>Preview import</button>
          </div>
          <input
            ref={settingsFileRef}
            type="file"
            accept="application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void readImportFile('settings', file);
            }}
          />
        </div>

        <div className="adv-tool">
          <h3>Playtime backup</h3>
          <p>Only game playtime stats from <code>bloxplus.playtime</code>.</p>
          <div className="adv-actions">
            <button onClick={() => void exportPlaytime()}>Export playtime</button>
            <button onClick={() => playtimeFileRef.current?.click()}>Preview import</button>
          </div>
          <input
            ref={playtimeFileRef}
            type="file"
            accept="application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void readImportFile('playtime', file);
            }}
          />
        </div>
      </div>

      {pending && (
        <div className="adv-preview">
          <h3>{pending.kind === 'settings' ? 'Settings import preview' : 'Playtime import preview'}</h3>
          <ul>
            {pending.summary.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <div className="adv-actions">
            <button onClick={() => void applyPending()}>Apply import</button>
            <button className="adv-secondary" onClick={() => setPending(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="adv-restore">
        <div>
          <strong>Restore last pre-import backup</strong>
          <p>
            {restore
              ? `${restore.label}, saved ${new Date(restore.savedAt).toLocaleString()}`
              : 'No pre-import backup saved yet.'}
          </p>
        </div>
        <button disabled={!restore} onClick={() => void restorePrevious()}>Restore</button>
      </div>

      {status && <div className={`adv-status adv-status-${status.kind}`}>{status.text}</div>}
    </section>
  );
}

function PlaytimeManager() {
  const [entries, setEntries] = useState<GamePlaytimeEntry[]>([]);
  const [hydratedNames, setHydratedNames] = useState<Map<number, string>>(new Map());
  const [selectedKey, setSelectedKey] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('time-desc');
  const [editName, setEditName] = useState('');
  const [importedMinutes, setImportedMinutes] = useState(0);
  const [trackedMinutes, setTrackedMinutes] = useState(0);
  const [addHours, setAddHours] = useState('');
  const [addMinutes, setAddMinutes] = useState('');
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const reload = async (): Promise<void> => {
    const next = await getPlaytime();
    setEntries(next);
    if (!selectedKey && next[0]) setSelectedKey(playtimeEntryKey(next[0], 0));
  };

  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    const ids = [...new Set(entries
      .map((entry) => entry.universeId)
      .filter((id): id is number => typeof id === 'number' && id > 0))];
    if (!ids.length) {
      setHydratedNames(new Map());
      return;
    }
    let cancelled = false;
    void getGameInfo(ids).then((info) => {
      if (cancelled) return;
      const names = new Map<number, string>();
      for (const [id, game] of info) names.set(id, game.name);
      setHydratedNames(names);
    });
    return () => {
      cancelled = true;
    };
  }, [entries]);

  const visibleEntries = useMemo(() => {
    const f = query.trim().toLowerCase();
    return entries
      .map((entry, index) => ({ entry, index, key: playtimeEntryKey(entry, index) }))
      .filter(({ entry }) => {
        if (!f) return true;
        return (
          playtimeEntryLabel(entry, hydratedNames).toLowerCase().includes(f) ||
          String(entry.universeId ?? '').includes(f) ||
          String(entry.placeId ?? '').includes(f)
        );
      })
      .sort((a, b) => {
        if (sort === 'name') {
          return playtimeEntryLabel(a.entry, hydratedNames).localeCompare(playtimeEntryLabel(b.entry, hydratedNames));
        }
        if (sort === 'recent') {
          return Date.parse(b.entry.lastPlayedAt ?? '') - Date.parse(a.entry.lastPlayedAt ?? '');
        }
        return (b.entry.totalSeconds ?? 0) - (a.entry.totalSeconds ?? 0);
      });
  }, [entries, hydratedNames, query, sort]);

  const selected =
    visibleEntries.find((item) => item.key === selectedKey) ??
    entries.map((entry, index) => ({ entry, index, key: playtimeEntryKey(entry, index) }))
      .find((item) => item.key === selectedKey) ??
    visibleEntries[0] ??
    null;

  useEffect(() => {
    if (!selected) return;
    setEditName(selected.entry.gameName ?? playtimeHydratedName(selected.entry, hydratedNames) ?? '');
    setImportedMinutes(secondsToMinutes(selected.entry.importedSeconds ?? 0));
    setTrackedMinutes(secondsToMinutes(selected.entry.trackedSeconds ?? 0));
  }, [selected?.key, hydratedNames]);

  const totalSeconds = entries.reduce((sum, entry) => sum + Math.max(0, entry.totalSeconds ?? 0), 0);
  const duplicateCount = countDuplicateUniverseEntries(entries);

  const writeEntries = async (next: GamePlaytimeEntry[], message: string): Promise<void> => {
    await setPlaytime(next);
    setEntries(next);
    setStatus({ kind: 'ok', text: message });
  };

  const updateSelected = async (patcher: (entry: GamePlaytimeEntry) => GamePlaytimeEntry): Promise<void> => {
    if (!selected) return;
    const next = entries.map((entry, index) => index === selected.index ? patcher(entry) : entry);
    await writeEntries(next, 'Playtime updated.');
  };

  const saveEdit = async (): Promise<void> => {
    const importedSeconds = Math.max(0, Math.round(importedMinutes * 60));
    const trackedSeconds = Math.max(0, Math.round(trackedMinutes * 60));
    await updateSelected((entry) => ({
      ...entry,
      gameName: editName.trim() || entry.gameName,
      importedSeconds,
      trackedSeconds,
      totalSeconds: importedSeconds + trackedSeconds,
      sources: normalizedPlaytimeSources(entry, importedSeconds, trackedSeconds),
    }));
  };

  const addManualTime = async (): Promise<void> => {
    const seconds = Math.max(0, Math.round(((Number(addHours) || 0) * 60 + (Number(addMinutes) || 0)) * 60));
    if (!seconds) {
      setStatus({ kind: 'err', text: 'Enter time to add first.' });
      return;
    }
    await updateSelected((entry) => {
      const trackedSeconds = Math.max(0, (entry.trackedSeconds ?? 0) + seconds);
      return {
        ...entry,
        trackedSeconds,
        totalSeconds: Math.max(0, entry.importedSeconds ?? 0) + trackedSeconds,
        lastPlayedAt: new Date().toISOString(),
        sources: [...new Set([...(entry.sources ?? []), 'tracked_extension', 'manual_adjustment'] as const)],
      };
    });
    setAddHours('');
    setAddMinutes('');
  };

  const resetSelected = async (): Promise<void> => {
    if (!selected) return;
    const ok = confirm(
      `Are you sure you want to reset playtime for ${playtimeEntryLabel(selected.entry, hydratedNames)}?\n\nThis sets imported and tracked time to 0.`
    );
    if (!ok) return;
    await updateSelected((entry) => ({
      ...entry,
      importedSeconds: 0,
      trackedSeconds: 0,
      totalSeconds: 0,
      windowSeconds: undefined,
      sources: [],
    }));
  };

  const mergeDuplicates = async (): Promise<void> => {
    const next = mergeDuplicateUniverseEntries(entries);
    await writeEntries(next, `Merged ${entries.length - next.length} duplicate entr${entries.length - next.length === 1 ? 'y' : 'ies'}.`);
    setSelectedKey(next[0] ? playtimeEntryKey(next[0], 0) : '');
  };

  const gameUrl = selected ? playtimeGameUrl(selected.entry) : null;

  return (
    <section id="playtime" className="adv-card">
      <div className="adv-card-head">
        <div>
          <h2>Playtime manager</h2>
          <p>{entries.length} games, {formatDuration(totalSeconds)} total.</p>
        </div>
      </div>

      <div className="adv-playtime-toolbar">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by game or id" />
        <select value={sort} onChange={(e) => setSort(e.target.value as SortMode)}>
          <option value="time-desc">Most time</option>
          <option value="recent">Recently played</option>
          <option value="name">Name</option>
        </select>
      </div>

      {duplicateCount > 0 && (
        <div className="adv-warning">
          {duplicateCount} duplicate universe entr{duplicateCount === 1 ? 'y' : 'ies'} found.
          <button onClick={() => void mergeDuplicates()}>Merge duplicates</button>
        </div>
      )}

      {!entries.length ? (
        <p>No playtime entries yet.</p>
      ) : (
        <div className="adv-playtime-editor">
          <label>
            Game
            <select value={selected?.key ?? ''} onChange={(e) => setSelectedKey(e.target.value)}>
              {visibleEntries.map(({ entry, key }) => (
                <option key={key} value={key}>
                  {playtimeEntryLabel(entry, hydratedNames)} - {formatDuration(entry.totalSeconds ?? 0)}
                </option>
              ))}
            </select>
          </label>

          {selected && (
            <>
              <div className="adv-grid-three">
                <label>Name<input value={editName} onChange={(e) => setEditName(e.target.value)} /></label>
                <label>Imported minutes<input type="number" min="0" value={importedMinutes} onChange={(e) => setImportedMinutes(Number(e.target.value) || 0)} /></label>
                <label>Tracked minutes<input type="number" min="0" value={trackedMinutes} onChange={(e) => setTrackedMinutes(Number(e.target.value) || 0)} /></label>
              </div>
              <div className="adv-actions">
                <button onClick={() => void saveEdit()}>Save edit</button>
                {gameUrl && <a className="adv-button-link" href={gameUrl} target="_blank" rel="noreferrer">Open game page</a>}
                <button className="adv-danger" onClick={() => void resetSelected()}>Reset game</button>
              </div>
              <div className="adv-add-time">
                <label>Add hours<input type="number" min="0" value={addHours} onChange={(e) => setAddHours(e.target.value)} /></label>
                <label>Add minutes<input type="number" min="0" value={addMinutes} onChange={(e) => setAddMinutes(e.target.value)} /></label>
                <button onClick={() => void addManualTime()}>Add time</button>
              </div>
            </>
          )}
        </div>
      )}
      {status && <div className={`adv-status adv-status-${status.kind}`}>{status.text}</div>}
    </section>
  );
}

async function buildBackup(): Promise<BackupFile> {
  const [syncAll, localAll] = await Promise.all([
    chrome.storage.sync.get(BACKUP_SYNC_KEYS as unknown as string[]),
    chrome.storage.local.get(BACKUP_LOCAL_KEYS as unknown as string[]),
  ]);
  const sync: Record<string, unknown> = {};
  for (const k of BACKUP_SYNC_KEYS) if (syncAll[k] !== undefined) sync[k] = syncAll[k];
  const local: Record<string, unknown> = {};
  for (const k of BACKUP_LOCAL_KEYS) if (localAll[k] !== undefined) local[k] = localAll[k];
  return { version: 1, exportedAt: new Date().toISOString(), sync, local };
}

async function buildPlaytimeBackup(): Promise<BackupFile> {
  const localAll = await chrome.storage.local.get([PLAYTIME_BACKUP_KEY]);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    sync: {},
    local: { [PLAYTIME_BACKUP_KEY]: localAll[PLAYTIME_BACKUP_KEY] ?? [] },
  };
}

function parseBackup(text: string): BackupFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not a valid JSON file.');
  }
  if (!raw || typeof raw !== 'object') throw new Error('Backup is empty or malformed.');
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) throw new Error(`Unsupported backup version: ${String(obj.version)}.`);
  const sync = (obj.sync && typeof obj.sync === 'object' ? obj.sync : {}) as Record<string, unknown>;
  const local = (obj.local && typeof obj.local === 'object' ? obj.local : {}) as Record<string, unknown>;
  const cleanSync: Record<string, unknown> = {};
  for (const k of BACKUP_SYNC_KEYS) if (k in sync) cleanSync[k] = sync[k];
  const cleanLocal: Record<string, unknown> = {};
  for (const k of BACKUP_LOCAL_KEYS) if (k in local) cleanLocal[k] = local[k];
  return {
    version: 1,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    sync: cleanSync,
    local: cleanLocal,
  };
}

function parsePlaytimeBackup(text: string): BackupFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not a valid JSON file.');
  }
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  if (obj.version !== 1) throw new Error(`Unsupported backup version: ${String(obj.version)}.`);
  const local = obj.local && typeof obj.local === 'object'
    ? obj.local as Record<string, unknown>
    : {};
  if (!(PLAYTIME_BACKUP_KEY in local)) throw new Error('This backup does not contain playtime data.');
  return {
    version: 1,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    sync: {},
    local: { [PLAYTIME_BACKUP_KEY]: local[PLAYTIME_BACKUP_KEY] },
  };
}

async function applyBackup(file: BackupFile, kind: BackupKind): Promise<void> {
  const syncKeys = kind === 'settings' ? [...BACKUP_SYNC_KEYS] : [];
  const localKeys = kind === 'settings' ? [...BACKUP_LOCAL_KEYS] : [PLAYTIME_BACKUP_KEY];
  const syncSet = pickKnownKeys(file.sync, syncKeys);
  const localSet = pickKnownKeys(file.local, localKeys);
  const syncRemove = syncKeys.filter((key) => !(key in file.sync));
  const localRemove = localKeys.filter((key) => !(key in file.local));

  if (Object.keys(syncSet).length) await chrome.storage.sync.set(syncSet);
  if (syncRemove.length) await chrome.storage.sync.remove(syncRemove);
  if (Object.keys(localSet).length) await chrome.storage.local.set(localSet);
  if (localRemove.length) await chrome.storage.local.remove(localRemove);
}

async function savePreImportBackup(kind: BackupKind, file: BackupFile): Promise<void> {
  const stored: StoredPreImportBackup = {
    kind,
    label: kind === 'settings' ? 'Settings backup' : 'Playtime backup',
    savedAt: new Date().toISOString(),
    file,
  };
  await chrome.storage.local.set({ [LAST_PRE_IMPORT_BACKUP_KEY]: stored });
}

function pickKnownKeys(source: Record<string, unknown>, allowed: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in source) picked[key] = source[key];
  }
  return picked;
}

function inferBackupKind(file: BackupFile): BackupKind {
  return PLAYTIME_BACKUP_KEY in file.local ? 'playtime' : 'settings';
}

function downloadBackup(file: BackupFile, prefix: string): void {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = file.exportedAt.replace(/[:.]/g, '-').slice(0, 19);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${prefix}-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function summarizeSettingsBackup(file: BackupFile): string[] {
  return [
    file.sync['bloxplus.settings'] ? 'Settings and hotkeys: present' : 'Settings and hotkeys: not included',
    `Folders: ${countFolders(file.local['bloxplus.folders'])}`,
    `Themes: ${countUserThemes(file.local['bloxplus.userThemes'])}`,
    `Customizations: ${countEntries(file.local['bloxplus.customizations'])}`,
    `Profile annotations: ${countRecord(file.local['bloxplus.profileAnnotations'])}`,
  ];
}

function summarizePlaytimeBackup(file: BackupFile): string[] {
  const entries = Array.isArray(file.local[PLAYTIME_BACKUP_KEY])
    ? file.local[PLAYTIME_BACKUP_KEY] as GamePlaytimeEntry[]
    : [];
  const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.totalSeconds ?? 0), 0);
  return [`Playtime entries: ${entries.length}`, `Total time: ${formatDuration(total)}`];
}

function countFolders(value: unknown): number {
  return value && typeof value === 'object' && Array.isArray((value as { folders?: unknown }).folders)
    ? ((value as { folders: unknown[] }).folders.length)
    : 0;
}

function countUserThemes(value: unknown): number {
  return value && typeof value === 'object' && Array.isArray((value as { order?: unknown }).order)
    ? ((value as { order: unknown[] }).order.length)
    : 0;
}

function countEntries(value: unknown): number {
  return value && typeof value === 'object' && (value as { entries?: unknown }).entries && typeof (value as { entries?: unknown }).entries === 'object'
    ? Object.keys((value as { entries: Record<string, unknown> }).entries).length
    : 0;
}

function countRecord(value: unknown): number {
  return value && typeof value === 'object' ? Object.keys(value).length : 0;
}

function playtimeEntryKey(entry: GamePlaytimeEntry, index: number): string {
  return `${entry.universeId ?? 'no-u'}:${entry.placeId ?? 'no-p'}:${index}`;
}

function playtimeHydratedName(entry: GamePlaytimeEntry, hydratedNames: Map<number, string>): string | undefined {
  return typeof entry.universeId === 'number' ? hydratedNames.get(entry.universeId) : undefined;
}

function playtimeEntryLabel(entry: GamePlaytimeEntry, hydratedNames = new Map<number, string>()): string {
  return entry.gameName
    || playtimeHydratedName(entry, hydratedNames)
    || (entry.universeId ? `Universe ${entry.universeId}` : entry.placeId ? `Place ${entry.placeId}` : 'Unknown game');
}

function playtimeGameUrl(entry: GamePlaytimeEntry): string | null {
  if (entry.placeId) return `https://www.roblox.com/games/${entry.placeId}`;
  if (entry.universeId) return `https://www.roblox.com/games/?Keyword=${entry.universeId}`;
  return null;
}

function secondsToMinutes(seconds: number): number {
  return Math.round(Math.max(0, seconds) / 60);
}

function formatDuration(seconds: number): string {
  const mins = Math.round(Math.max(0, seconds) / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

function normalizedPlaytimeSources(
  entry: GamePlaytimeEntry,
  importedSeconds: number,
  trackedSeconds: number
): GamePlaytimeEntry['sources'] {
  const sources = new Set(entry.sources ?? []);
  if (importedSeconds > 0) sources.add('imported_ropro');
  else sources.delete('imported_ropro');
  if (trackedSeconds > 0) sources.add('tracked_extension');
  else sources.delete('tracked_extension');
  return [...sources];
}

function countDuplicateUniverseEntries(entries: GamePlaytimeEntry[]): number {
  const counts = new Map<number, number>();
  for (const entry of entries) {
    if (typeof entry.universeId !== 'number') continue;
    counts.set(entry.universeId, (counts.get(entry.universeId) ?? 0) + 1);
  }
  let duplicates = 0;
  for (const count of counts.values()) if (count > 1) duplicates += count - 1;
  return duplicates;
}

function mergeDuplicateUniverseEntries(entries: GamePlaytimeEntry[]): GamePlaytimeEntry[] {
  const byUniverse = new Map<number, GamePlaytimeEntry>();
  const passthrough: GamePlaytimeEntry[] = [];
  for (const entry of entries) {
    if (typeof entry.universeId !== 'number') {
      passthrough.push(entry);
      continue;
    }
    const current = byUniverse.get(entry.universeId);
    if (!current) {
      byUniverse.set(entry.universeId, { ...entry, sources: [...(entry.sources ?? [])] });
      continue;
    }
    const importedSeconds = Math.max(current.importedSeconds ?? 0, entry.importedSeconds ?? 0);
    const trackedSeconds = Math.max(current.trackedSeconds ?? 0, entry.trackedSeconds ?? 0);
    byUniverse.set(entry.universeId, {
      ...current,
      ...entry,
      gameName: current.gameName ?? entry.gameName,
      placeId: current.placeId ?? entry.placeId,
      importedSeconds,
      trackedSeconds,
      totalSeconds: importedSeconds + trackedSeconds,
      lastPlayedAt: latestIso(current.lastPlayedAt, entry.lastPlayedAt),
      windowSeconds: { ...(current.windowSeconds ?? {}), ...(entry.windowSeconds ?? {}) },
      sources: [...new Set([...(current.sources ?? []), ...(entry.sources ?? [])])],
    });
  }
  return [...byUniverse.values(), ...passthrough].map((entry) => ({
    ...entry,
    windowSeconds: entry.windowSeconds && Object.keys(entry.windowSeconds).length ? entry.windowSeconds : undefined,
  }));
}

function latestIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return b > a ? b : a;
}

const advancedCss = `
  :root { color-scheme: dark; }
  body { margin: 0; background: #11161c; color: #e8edf2; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  button, input, select, textarea { font: inherit; }
  .adv-page { min-height: 100vh; display: flex; }
  .adv-sidebar { width: 230px; padding: 22px 16px; border-right: 1px solid rgba(255,255,255,0.08); background: #171d24; position: sticky; top: 0; height: 100vh; box-sizing: border-box; }
  .adv-brand { font-size: 20px; font-weight: 850; margin-bottom: 18px; }
  .adv-nav-button { width: 100%; min-height: 0; display: block; color: rgba(232,237,242,0.78); text-decoration: none; padding: 9px 10px; border-radius: 6px; font-size: 13px; text-align: left; background: transparent; border: 0; font-weight: 600; cursor: pointer; }
  .adv-nav-button:hover { background: rgba(255,255,255,0.07); color: #fff; filter: none; }
  .adv-main { flex: 1; max-width: 1080px; padding: 30px; box-sizing: border-box; }
  .adv-hero { margin-bottom: 18px; }
  .adv-hero p { margin: 0 0 4px; color: #8fbef5; font-size: 12px; font-weight: 750; text-transform: uppercase; letter-spacing: .08em; }
  .adv-hero h1 { margin: 0; font-size: 30px; letter-spacing: 0; }
  .adv-card { background: #1b222b; border: 1px solid rgba(255,255,255,0.09); border-radius: 8px; padding: 18px; margin-bottom: 18px; box-shadow: 0 14px 34px rgba(0,0,0,0.22); }
  .adv-card h2 { margin: 0 0 4px; font-size: 19px; }
  .adv-card h3 { margin: 0 0 8px; font-size: 14px; }
  .adv-card p { margin: 0; color: rgba(232,237,242,0.68); font-size: 13px; line-height: 1.5; }
  .adv-card-head { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
  .adv-two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .adv-tool, .adv-preview, .adv-restore, .adv-warning { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 7px; padding: 13px; }
  .adv-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  button, .adv-button-link { min-height: 32px; padding: 0 12px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.16); background: #268ddd; color: #fff; font-weight: 750; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
  button:hover, .adv-button-link:hover { filter: brightness(1.08); }
  button:disabled { opacity: .45; cursor: default; filter: none; }
  .adv-secondary { background: rgba(255,255,255,0.08); }
  .adv-danger { background: rgba(217,83,79,0.22); border-color: rgba(217,83,79,0.42); color: #ffc0bd; }
  .adv-preview { margin-top: 14px; }
  .adv-preview ul { margin: 8px 0 0; padding-left: 18px; color: rgba(232,237,242,0.82); font-size: 13px; }
  .adv-restore { margin-top: 14px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .adv-status { margin-top: 12px; padding: 10px 12px; border-radius: 6px; font-size: 13px; }
  .adv-status-ok { background: rgba(46,178,76,0.14); border: 1px solid rgba(46,178,76,0.36); color: #b7efc3; }
  .adv-status-err { background: rgba(217,83,79,0.14); border: 1px solid rgba(217,83,79,0.40); color: #ffc0bd; }
  .adv-playtime-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) 180px; gap: 10px; margin-bottom: 12px; }
  input, select { height: 34px; border-radius: 5px; border: 1px solid rgba(255,255,255,0.14); background: #111820; color: #fff; padding: 0 10px; box-sizing: border-box; color-scheme: dark; }
  select option { background: #111820; color: #fff; }
  .adv-warning { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: #ffe08a; border-color: rgba(245,190,65,0.34); background: rgba(245,190,65,0.10); margin-bottom: 12px; }
  .adv-playtime-editor { display: flex; flex-direction: column; gap: 12px; }
  .adv-playtime-editor label, .adv-grid-three label, .adv-add-time label { display: flex; flex-direction: column; gap: 6px; color: rgba(232,237,242,0.68); font-size: 12px; font-weight: 650; }
  .adv-grid-three { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
  .adv-add-time { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 10px; align-items: end; }
  code { color: #bcdcff; }
  @media (max-width: 820px) {
    .adv-page { display: block; }
    .adv-sidebar { position: static; width: auto; height: auto; border-right: 0; border-bottom: 1px solid rgba(255,255,255,0.08); }
    .adv-main { padding: 18px; }
    .adv-two, .adv-playtime-toolbar, .adv-grid-three, .adv-add-time { grid-template-columns: 1fr; }
  }
`;
