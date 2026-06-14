import { useEffect, useMemo, useRef, useState } from 'react';
import { getGameInfo, placeIdToUniverseId } from '@/api/games';
import {
  addTrackingBucketSample,
  getActivePlaytimeUserId,
  getPlaytime,
  hasPlaytimeStorageChange,
  PLAYTIME_BY_USER_KEY,
  PLAYTIME_KEY,
  setPlaytime,
} from '@/storage/playtimeStore';
import { getSettings, setSettings } from '@/storage/settingsStore';
import { getDefaultThemeSchedule } from '@/storage/themeSchedule';
import { mergePlaytime } from '@/playtime/normalizePlaytime';
import { parseRoProJson } from '@/playtime/importRoPro';
import { GamePlaytimeEntry } from '@/types';

const BACKUP_LOCAL_KEYS = [
  'bloxplus.customizations',
  'bloxplus.folders',
  'bloxplus.lastSeen',
  'bloxplus.profileAnnotations',
  'bloxplus.badgerhub.annotations',
  'bloxplus.customTheme',
  'bloxplus.userThemes',
] as const;

const BACKUP_SYNC_KEYS = ['bloxplus.settings'] as const;
const PLAYTIME_BACKUP_KEY = PLAYTIME_KEY;
const LAST_PRE_IMPORT_BACKUP_KEY = 'bloxplus.lastPreImportBackup'; // legacy single-slot; migrated lazily
const PRE_IMPORT_BACKUPS_KEY = 'bloxplus.preImportBackups';
const PRE_IMPORT_BACKUP_MAX = 3;

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

const ROPRO_EXPORT_SCRIPT = `(async () => {
  const begin = '---SVIBLOX-ROPRO-PLAYTIME-EXPORT-BEGIN---';
  const end = '---SVIBLOX-ROPRO-PLAYTIME-EXPORT-END---';
  const read = (area) => new Promise((resolve) => chrome.storage[area].get(null, resolve));
  const [local, sync] = await Promise.all([read('local'), read('sync')]);
  const payload = {
    ...(local || {}),
    __svibloxRoProExport: {
      source: 'RoPro',
      exportedAt: new Date().toISOString(),
      localKeys: Object.keys(local || {}),
      syncKeys: Object.keys(sync || {}),
    },
    __roproSync: sync || {},
  };
  const text = begin + '\\n' + JSON.stringify(payload, null, 2) + '\\n' + end;
  let copied = false;
  try {
    if (typeof copy === 'function') {
      copy(text);
      copied = true;
    } else if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch {}
  console.log(copied ? 'SviBlox RoPro export copied.' : 'SviBlox RoPro export printed below. Copy everything between the markers.');
  console.log(text);
  return text;
})();`;

export function AdvancedOptions() {
  const scrollToSection = (id: string): void => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Deep-link handling. The popup's storage-full warning opens
  // `options.html#storage`, and the user can land on any of these section
  // hashes from a bookmark. Scroll once on mount.
  useEffect(() => {
    const hash = location.hash.replace(/^#/, '');
    if (!hash) return;
    // Defer one tick so the section is in the DOM.
    requestAnimationFrame(() => scrollToSection(hash));
  }, []);

  return (
    <div className="adv-page">
      <style>{advancedCss}</style>
      <aside className="adv-sidebar">
        <div className="adv-brand">SviBlox</div>
        <button className="adv-nav-button" type="button" onClick={() => scrollToSection('data')}>
          Data & backups
        </button>
        <button className="adv-nav-button" type="button" onClick={() => scrollToSection('storage')}>
          Storage manager
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
        <StorageManager />
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
  const [restoreList, setRestoreList] = useState<StoredPreImportBackup[]>([]);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refreshRestore = async (): Promise<void> => {
    setRestoreList(await readPreImportBackups());
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

  const restoreFromHistory = async (entry: StoredPreImportBackup): Promise<void> => {
    if (!confirm(`Restore ${entry.label} from ${new Date(entry.savedAt).toLocaleString()}?`)) return;
    await applyBackup(entry.file, entry.kind ?? inferBackupKind(entry.file));
    setStatus({ kind: 'ok', text: 'Pre-import backup restored.' });
  };

  const dropFromHistory = async (savedAt: string): Promise<void> => {
    const next = restoreList.filter((entry) => entry.savedAt !== savedAt);
    await chrome.storage.local.set({ [PRE_IMPORT_BACKUPS_KEY]: next });
    setRestoreList(next);
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
          <p>Themes, folders, customizations, Badger Hub edits, nicknames, hotkeys, and settings. Playtime is separate.</p>
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
          <p>Only game playtime stats for the current Roblox account.</p>
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
        <div className="adv-restore-head">
          <strong>Pre-import backup history</strong>
          <span className="adv-restore-meta">Last {PRE_IMPORT_BACKUP_MAX} kept · oldest drops on new import</span>
        </div>
        {restoreList.length === 0 ? (
          <p className="adv-restore-empty">No pre-import backups saved yet.</p>
        ) : (
          <ul className="adv-restore-list">
            {restoreList.map((entry) => (
              <li key={entry.savedAt} className="adv-restore-row">
                <div className="adv-restore-row-text">
                  <strong>{entry.label}</strong>
                  <span>{new Date(entry.savedAt).toLocaleString()}</span>
                </div>
                <div className="adv-restore-row-actions">
                  <button onClick={() => void restoreFromHistory(entry)}>Restore</button>
                  <button className="adv-secondary" onClick={() => void dropFromHistory(entry.savedAt)}>Drop</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {status && <div className={`adv-status adv-status-${status.kind}`}>{status.text}</div>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Storage manager
// ---------------------------------------------------------------------------

const SYNC_TOTAL_QUOTA = 102400;
const SYNC_ITEM_QUOTA = 8192;
// Local storage has no real cap with `unlimitedStorage` in the manifest —
// the only ceiling is disk. These are *soft* reference values for the
// progress bar so unusual growth still draws the eye. Past `LOCAL_SOFT_DANGER`
// is "you probably have stale cache buildup" territory.
const LOCAL_SOFT_TARGET = 20 * 1024 * 1024;
const LOCAL_SOFT_DANGER = 50 * 1024 * 1024;
const ACTION_CANCELLED = Symbol('action-cancelled');

const LOCAL_KEY_LABELS: Record<string, string> = {
  'bloxplus.customizations': 'Customize edits',
  'bloxplus.folders': 'Folders',
  'bloxplus.lastSeen': 'Friend last-seen snapshots',
  'bloxplus.profileAnnotations': 'Profile notes & nicknames',
  'bloxplus.badgerhub.annotations': 'Badger Hub edits & added badges',
  'bloxplus.customTheme': 'Custom theme (legacy slot)',
  'bloxplus.userThemes': 'Theme presets (incl. images)',
  [PLAYTIME_KEY]: 'Playtime entries (legacy)',
  [PLAYTIME_BY_USER_KEY]: 'Playtime entries by Roblox account',
  'bloxplus.playtime.meta': 'Playtime migration metadata',
  'bloxplus.uhbl.sheet': 'UHBL sheet snapshot',
  'bloxplus.uhbl.mediaMap': 'UHBL video URL map (accumulated across refreshes)',
  'bloxplus.uhbl.mediaMeta': 'UHBL media-fetch metadata',
  'bloxplus.badgerhub.hub': 'Badger Hub sheet snapshot',
  'bloxplus.badgerhub.progress': 'Badger Hub owned progress',
  'bloxplus.badgerhub.knownOwned': 'Badger Hub unlock baseline',
  'bloxplus.badgerhub.gamebadges': 'Badger Hub saved badge lists',
  'bloxplus.lastPreImportBackup': 'Pre-import restore backup (legacy)',
  'bloxplus.preImportBackups': `Pre-import restore history (last ${PRE_IMPORT_BACKUP_MAX})`,
};

const CACHE_PREFIX = 'bloxplus.cache.';
const BADGER_HUB_LOCAL_KEYS = [
  'bloxplus.badgerhub.hub',
  'bloxplus.badgerhub.progress',
  'bloxplus.badgerhub.knownOwned',
  'bloxplus.badgerhub.gamebadges',
];

interface KeyUsage {
  key: string;
  label: string;
  bytes: number;
}

interface StorageView {
  sync: {
    itemBytes: number;
    totalBytes: number;
  };
  settingsBreakdown: KeyUsage[];
  local: KeyUsage[];
  cacheBytes: number;
  cacheKeyCount: number;
  localTotalBytes: number;
  hotkeyCount: number;
  scheduleSlotCount: number;
  scheduleEnabled: boolean;
  orphanPlaytimeCount: number;
  legacyCustomThemeBytes: number;
}

function bytesLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function StorageManager() {
  const [view, setView] = useState<StorageView | null>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    const v = await readStorageView();
    setView(v);
  };

  useEffect(() => {
    void refresh();
    const onChange = () => {
      void refresh();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const runAction = async (
    label: string,
    action: () => Promise<number | void | typeof ACTION_CANCELLED>
  ): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await action();
      if (result === ACTION_CANCELLED) return;
      const tail = typeof result === 'number' ? ` (${result} item${result === 1 ? '' : 's'})` : '';
      setStatus({ kind: 'ok', text: `${label}${tail}.` });
      await refresh();
    } catch (err) {
      setStatus({ kind: 'err', text: `${label} failed: ${(err as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const clearHotkeys = (): Promise<void> => runAction('Hotkeys cleared', async () => {
    const settings = await getSettings();
    const count = Object.keys(settings.gameHotkeys ?? {}).length;
    if (!count) return 0;
    if (!confirm(`Clear all ${count} hotkey${count === 1 ? '' : 's'}? You can rebind from the popup.`)) return ACTION_CANCELLED;
    await setSettings({ gameHotkeys: {} });
    return count;
  });

  const resetSchedule = (): Promise<void> => runAction('Theme schedule reset', async () => {
    if (!confirm('Reset theme schedule to default 2 slots (disabled)? Your currently active themeId is unaffected.')) return ACTION_CANCELLED;
    await setSettings({ themeSchedule: getDefaultThemeSchedule() });
  });

  const clearApiCaches = (): Promise<void> => runAction('API caches cleared', async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
    if (!keys.length) return 0;
    await chrome.storage.local.remove(keys);
    return keys.length;
  });

  const dropUhbl = (): Promise<void> => runAction('UHBL snapshot dropped', async () => {
    await chrome.storage.local.remove([
      'bloxplus.uhbl.sheet',
      'bloxplus.uhbl.mediaMap',
      'bloxplus.uhbl.mediaMeta',
    ]);
  });

  const dropBadgerHub = (): Promise<void> => runAction('Badger Hub data dropped', async () => {
    if (!confirm('Drop saved Badger Hub sheet data, badge lists, progress, and unlock baseline? It will be rebuilt as you load/update Badger Hub again.')) return ACTION_CANCELLED;
    await chrome.storage.local.remove(BADGER_HUB_LOCAL_KEYS);
  });

  const dropLastSeen = (): Promise<void> => runAction('Last-seen snapshots dropped', async () => {
    if (!confirm('Drop friend last-seen snapshots? The background poll will rebuild them as friends go online again.')) return ACTION_CANCELLED;
    await chrome.storage.local.remove('bloxplus.lastSeen');
  });

  const dropPreImport = (): Promise<void> => runAction('Pre-import backups dropped', async () => {
    await chrome.storage.local.remove(['bloxplus.lastPreImportBackup', 'bloxplus.preImportBackups']);
  });

  const dropLegacyTheme = (): Promise<void> => runAction('Legacy custom theme dropped', async () => {
    if (!confirm('Drop the legacy bloxplus.customTheme slot? Your saved themes in the new multi-preset list are unaffected. Only kept around for downgrade compatibility.')) return ACTION_CANCELLED;
    await chrome.storage.local.remove('bloxplus.customTheme');
  });

  const dropOrphanPlaytime = (): Promise<void> => runAction('Orphan playtime entries dropped', async () => {
    const entries = await getPlaytime();
    const kept = entries.filter((e) =>
      (typeof e.universeId === 'number' && e.universeId > 0) ||
      (e.gameName && e.gameName.trim().length > 0)
    );
    const dropped = entries.length - kept.length;
    if (!dropped) return 0;
    if (!confirm(`Drop ${dropped} playtime entr${dropped === 1 ? 'y' : 'ies'} with no name and no universeId?`)) return ACTION_CANCELLED;
    await setPlaytime(kept);
    return dropped;
  });

  if (!view) {
    return (
      <section id="storage" className="adv-card">
        <h2>Storage manager</h2>
        <p>Measuring…</p>
      </section>
    );
  }

  const itemPct = Math.min(100, Math.round((view.sync.itemBytes / SYNC_ITEM_QUOTA) * 100));
  const totalSyncPct = Math.min(100, Math.round((view.sync.totalBytes / SYNC_TOTAL_QUOTA) * 100));
  // For the local meter we visualize against the soft danger threshold so
  // 50 MB fills the bar — there's no real quota with `unlimitedStorage`.
  const localFillPct = Math.min(100, Math.round((view.localTotalBytes / LOCAL_SOFT_DANGER) * 100));
  const localTone: 'ok' | 'warn' | 'danger' =
    view.localTotalBytes >= LOCAL_SOFT_DANGER ? 'danger' :
    view.localTotalBytes >= LOCAL_SOFT_TARGET ? 'warn' : 'ok';

  return (
    <section id="storage" className="adv-card">
      <div className="adv-card-head">
        <div>
          <h2>Storage manager</h2>
          <p>
            See what's using extension storage and trim what you don't need. Hotkeys and theme schedule
            live in the synced 8 KB settings item — the practical ceiling that bites first.
          </p>
        </div>
        <button onClick={() => void refresh()} disabled={busy}>Refresh</button>
      </div>

      <div className="adv-storage-meters">
        <StorageMeter
          title="Sync · settings item"
          bytes={view.sync.itemBytes}
          quota={SYNC_ITEM_QUOTA}
          pct={itemPct}
          subtitle="hotkeys + schedule + toggles, capped at 8 KB by Chrome"
          danger={itemPct >= 90}
        />
        <StorageMeter
          title="Sync · total"
          bytes={view.sync.totalBytes}
          quota={SYNC_TOTAL_QUOTA}
          pct={totalSyncPct}
          subtitle="all sync items, capped at 100 KB"
        />
        <StorageMeter
          title="Local · total"
          bytes={view.localTotalBytes}
          quota={null}
          pct={localFillPct}
          tone={localTone}
          subtitle={`no hard cap (unlimitedStorage); soft target ${bytesLabel(LOCAL_SOFT_TARGET)}, unusual past ${bytesLabel(LOCAL_SOFT_DANGER)}`}
        />
      </div>

      <div className="adv-storage-section">
        <h3>What's in your settings item ({bytesLabel(view.sync.itemBytes)})</h3>
        <table className="adv-storage-table">
          <thead>
            <tr><th>Section</th><th>Approx. size</th></tr>
          </thead>
          <tbody>
            {view.settingsBreakdown.map((row) => (
              <tr key={row.key}>
                <td>{row.label}</td>
                <td>{bytesLabel(row.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="adv-actions">
          <button onClick={() => void clearHotkeys()} disabled={busy || view.hotkeyCount === 0}>
            Clear {view.hotkeyCount} hotkey{view.hotkeyCount === 1 ? '' : 's'}
          </button>
          <button onClick={() => void resetSchedule()} disabled={busy || (view.scheduleSlotCount <= 2 && !view.scheduleEnabled)}>
            Reset theme schedule ({view.scheduleSlotCount} slot{view.scheduleSlotCount === 1 ? '' : 's'})
          </button>
        </div>
      </div>

      <div className="adv-storage-section">
        <h3>Local storage breakdown</h3>
        <table className="adv-storage-table">
          <thead>
            <tr><th>Key</th><th>Size</th></tr>
          </thead>
          <tbody>
            {view.local.map((row) => (
              <tr key={row.key}>
                <td>{row.label}<code className="adv-storage-key">{row.key}</code></td>
                <td>{bytesLabel(row.bytes)}</td>
              </tr>
            ))}
            {view.cacheKeyCount > 0 && (
              <tr>
                <td>API caches<code className="adv-storage-key">{CACHE_PREFIX}* ({view.cacheKeyCount} keys)</code></td>
                <td>{bytesLabel(view.cacheBytes)}</td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="adv-actions">
          <button className="adv-secondary" onClick={() => void clearApiCaches()} disabled={busy || view.cacheKeyCount === 0}>
            Clear API caches
          </button>
          <button className="adv-secondary" onClick={() => void dropUhbl()} disabled={busy}>
            Drop UHBL snapshot
          </button>
          <button className="adv-secondary" onClick={() => void dropBadgerHub()} disabled={busy}>
            Drop Badger Hub data
          </button>
          <button className="adv-secondary" onClick={() => void dropLastSeen()} disabled={busy}>
            Drop last-seen snapshots
          </button>
          <button className="adv-secondary" onClick={() => void dropPreImport()} disabled={busy}>
            Drop pre-import backup
          </button>
          {view.legacyCustomThemeBytes > 0 && (
            <button className="adv-secondary" onClick={() => void dropLegacyTheme()} disabled={busy}>
              Drop legacy custom theme ({bytesLabel(view.legacyCustomThemeBytes)})
            </button>
          )}
          {view.orphanPlaytimeCount > 0 && (
            <button className="adv-danger" onClick={() => void dropOrphanPlaytime()} disabled={busy}>
              Drop {view.orphanPlaytimeCount} orphan playtime entr{view.orphanPlaytimeCount === 1 ? 'y' : 'ies'}
            </button>
          )}
        </div>
      </div>

      {status && <div className={`adv-status adv-status-${status.kind}`}>{status.text}</div>}
    </section>
  );
}

function StorageMeter({
  title,
  bytes,
  quota,
  pct,
  subtitle,
  danger,
  tone,
}: {
  title: string;
  bytes: number;
  /** Pass null when there is no hard cap — the meter shows bytes used only. */
  quota: number | null;
  pct: number;
  subtitle: string;
  danger?: boolean;
  tone?: 'ok' | 'warn' | 'danger';
}) {
  const fillClass = tone
    ? `adv-meter-fill-${tone}`
    : danger || pct >= 90 ? 'adv-meter-fill-danger'
    : pct >= 75 ? 'adv-meter-fill-warn'
    : 'adv-meter-fill-ok';
  const value = quota === null
    ? bytesLabel(bytes)
    : `${bytesLabel(bytes)} / ${bytesLabel(quota)} (${pct}%)`;
  return (
    <div className="adv-meter">
      <div className="adv-meter-head">
        <strong>{title}</strong>
        <span>{value}</span>
      </div>
      <div className="adv-meter-bar"><div className={`adv-meter-fill ${fillClass}`} style={{ width: `${pct}%` }} /></div>
      <div className="adv-meter-sub">{subtitle}</div>
    </div>
  );
}

async function readStorageView(): Promise<StorageView> {
  const [all, syncItem, syncTotal, localTotal] = await Promise.all([
    chrome.storage.local.get(null),
    chrome.storage.sync.getBytesInUse('bloxplus.settings'),
    chrome.storage.sync.getBytesInUse(null),
    chrome.storage.local.getBytesInUse(null),
  ]);

  const localKeys = Object.keys(all).filter((k) => !k.startsWith(CACHE_PREFIX));
  const cacheKeys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));

  const localUsage = await Promise.all(
    localKeys.map(async (key) => ({
      key,
      label: LOCAL_KEY_LABELS[key] ?? key,
      bytes: await chrome.storage.local.getBytesInUse(key),
    }))
  );
  localUsage.sort((a, b) => b.bytes - a.bytes);

  const cacheBytes = cacheKeys.length
    ? await chrome.storage.local.getBytesInUse(cacheKeys)
    : 0;

  const settings = await getSettings();
  const settingsBreakdown: KeyUsage[] = [
    {
      key: 'gameHotkeys',
      label: `Hotkeys (${Object.keys(settings.gameHotkeys ?? {}).length} bindings)`,
      bytes: approxJsonBytes(settings.gameHotkeys ?? {}),
    },
    {
      key: 'themeSchedule',
      label: `Theme schedule (${settings.themeSchedule?.slots?.length ?? 0} slots${settings.themeSchedule?.enabled ? ', enabled' : ', disabled'})`,
      bytes: approxJsonBytes(settings.themeSchedule ?? {}),
    },
    {
      key: 'other',
      label: 'Other toggles & strings',
      bytes: approxJsonBytes(otherSettings(settings)),
    },
  ];
  settingsBreakdown.sort((a, b) => b.bytes - a.bytes);

  const playtime = await getPlaytime();
  const orphanPlaytimeCount = playtime.filter((e) =>
    !(typeof e.universeId === 'number' && e.universeId > 0) &&
    !(e.gameName && e.gameName.trim().length > 0)
  ).length;

  const legacyCustomThemeBytes = localUsage.find((u) => u.key === 'bloxplus.customTheme')?.bytes ?? 0;

  return {
    sync: { itemBytes: syncItem, totalBytes: syncTotal },
    settingsBreakdown,
    local: localUsage,
    cacheBytes,
    cacheKeyCount: cacheKeys.length,
    localTotalBytes: localTotal,
    hotkeyCount: Object.keys(settings.gameHotkeys ?? {}).length,
    scheduleSlotCount: settings.themeSchedule?.slots?.length ?? 0,
    scheduleEnabled: Boolean(settings.themeSchedule?.enabled),
    orphanPlaytimeCount,
    legacyCustomThemeBytes,
  };
}

function otherSettings(settings: object): Record<string, unknown> {
  const copy = { ...(settings as Record<string, unknown>) };
  delete copy.gameHotkeys;
  delete copy.themeSchedule;
  return copy;
}

function approxJsonBytes(value: unknown): number {
  // Rough approximation — Chrome's storage adds per-key overhead but this is
  // good enough to compare sections within the settings item.
  try {
    return new Blob([JSON.stringify(value)]).size;
  } catch {
    return 0;
  }
}

function PlaytimeManager() {
  const [entries, setEntries] = useState<GamePlaytimeEntry[]>([]);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [hydratedNames, setHydratedNames] = useState<Map<number, string>>(new Map());
  const [selectedKey, setSelectedKey] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('time-desc');
  const [editName, setEditName] = useState('');
  const [importedMinutes, setImportedMinutes] = useState(0);
  const [trackedMinutes, setTrackedMinutes] = useState(0);
  const [addHours, setAddHours] = useState('');
  const [addMinutes, setAddMinutes] = useState('');
  const [importingRoProJson, setImportingRoProJson] = useState(false);
  const [roProJson, setRoProJson] = useState('');
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const reload = async (): Promise<void> => {
    setAccountId(await getActivePlaytimeUserId());
    const next = await getPlaytime();
    setEntries(next);
    if (!selectedKey && next[0]) setSelectedKey(playtimeEntryKey(next[0], 0));
  };

  useEffect(() => {
    void reload();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
      if (area === 'local' && hasPlaytimeStorageChange(changes)) void reload();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
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
          return parseIsoTime(b.entry.lastPlayedAt) - parseIsoTime(a.entry.lastPlayedAt);
        }
        return (b.entry.totalSeconds ?? 0) - (a.entry.totalSeconds ?? 0);
      });
  }, [entries, hydratedNames, query, sort]);

  const selected =
    visibleEntries.find((item) => item.key === selectedKey) ??
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

  const copyRoProExportScript = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(ROPRO_EXPORT_SCRIPT);
      setStatus({
        kind: 'ok',
        text: 'RoPro export script copied. Paste it in RoPro service worker console, then paste the exported JSON here.',
      });
    } catch (err) {
      setStatus({ kind: 'err', text: `Could not copy export script: ${(err as Error).message}` });
    }
  };

  const importRoProJson = async (): Promise<void> => {
    if (importingRoProJson) return;
    setImportingRoProJson(true);
    try {
      const parsed = parseRoProJson(roProJson);
      const parsedEntries = await hydrateRoProPlaceEntries(parsed.entries);
      if (!parsedEntries.length) throw new Error('No importable playtime entries were found.');

      await savePreImportBackup('playtime', await buildPlaytimeBackup());
      const current = await getPlaytime();
      const next = mergePlaytime(current, parsedEntries);
      await setPlaytime(next);
      setEntries(next);
      setRoProJson('');
      const warningText = formatRoProWarnings(parsed.warnings);
      setStatus({
        kind: 'ok',
        text: `Imported ${parsedEntries.length} RoPro entr${parsedEntries.length === 1 ? 'y' : 'ies'} from pasted JSON. Existing games were updated, not duplicated.${warningText}`,
      });
    } catch (err) {
      setStatus({ kind: 'err', text: `RoPro JSON import failed: ${(err as Error).message}` });
    } finally {
      setImportingRoProJson(false);
    }
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
      trackingBuckets:
        trackedSeconds === Math.max(0, Math.round(entry.trackedSeconds ?? 0))
          ? entry.trackingBuckets
          : undefined,
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
      const withBucket = addTrackingBucketSample(entry, seconds);
      return {
        ...withBucket,
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
      trackingBuckets: undefined,
      sources: [],
    }));
  };

  const mergeDuplicates = async (): Promise<void> => {
    const priorUniverseId = selected?.entry.universeId;
    const next = mergeDuplicateUniverseEntries(entries);
    await writeEntries(next, `Merged ${entries.length - next.length} duplicate entr${entries.length - next.length === 1 ? 'y' : 'ies'}.`);
    const survivingIndex = typeof priorUniverseId === 'number'
      ? next.findIndex((entry) => entry.universeId === priorUniverseId)
      : -1;
    if (survivingIndex >= 0) {
      setSelectedKey(playtimeEntryKey(next[survivingIndex], survivingIndex));
    } else {
      setSelectedKey(next[0] ? playtimeEntryKey(next[0], 0) : '');
    }
  };

  const gameUrl = selected ? playtimeGameUrl(selected.entry) : null;

  return (
    <section id="playtime" className="adv-card">
      <div className="adv-card-head">
        <div>
          <h2>Playtime manager</h2>
          <p>
            {entries.length} games, {formatDuration(totalSeconds)} total
            {accountId ? ` for Roblox user ${accountId}.` : ' for the current Roblox account.'}
          </p>
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
      ) : !visibleEntries.length ? (
        <p>No playtime entries match your search.</p>
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

      <div className="adv-ropro-export">
        <div>
          <h3>RoPro storage export</h3>
          <p>
            Chrome blocks direct reads from RoPro's private extension storage. This helper copies an
            export script for RoPro's service worker console, then imports the JSON it prints.
          </p>
        </div>
        <div className="adv-actions">
          <button onClick={() => void copyRoProExportScript()}>Copy export script</button>
        </div>
        <textarea
          className="adv-ropro-json"
          value={roProJson}
          onChange={(e) => setRoProJson(e.target.value)}
          placeholder="Paste RoPro export JSON here"
          spellCheck={false}
        />
        <div className="adv-actions">
          <button
            onClick={() => void importRoProJson()}
            disabled={importingRoProJson || !roProJson.trim()}
          >
            {importingRoProJson ? 'Importing...' : 'Import pasted RoPro JSON'}
          </button>
        </div>
      </div>
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
  const entries = await getPlaytime();
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    sync: {},
    local: { [PLAYTIME_BACKUP_KEY]: entries },
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
  if (kind === 'playtime') {
    const entries = Array.isArray(file.local[PLAYTIME_BACKUP_KEY])
      ? file.local[PLAYTIME_BACKUP_KEY] as GamePlaytimeEntry[]
      : [];
    await setPlaytime(entries);
    return;
  }

  const syncKeys = kind === 'settings' ? [...BACKUP_SYNC_KEYS] : [];
  const localKeys = [...BACKUP_LOCAL_KEYS];
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
  const history = await readPreImportBackups();
  const next = [stored, ...history].slice(0, PRE_IMPORT_BACKUP_MAX);
  await chrome.storage.local.set({ [PRE_IMPORT_BACKUPS_KEY]: next });
  // Drop the legacy single-slot if present — fully migrated now.
  await chrome.storage.local.remove(LAST_PRE_IMPORT_BACKUP_KEY);
}

/**
 * Reads the history array, lazily migrating the legacy single-slot key into
 * it on first read. Newest entries are first; the array is trimmed to
 * PRE_IMPORT_BACKUP_MAX on every save.
 */
async function readPreImportBackups(): Promise<StoredPreImportBackup[]> {
  const raw = await chrome.storage.local.get([PRE_IMPORT_BACKUPS_KEY, LAST_PRE_IMPORT_BACKUP_KEY]);
  const arr = raw[PRE_IMPORT_BACKUPS_KEY];
  if (Array.isArray(arr) && arr.length) {
    return (arr as StoredPreImportBackup[]).filter(isStoredBackup);
  }
  const legacy = raw[LAST_PRE_IMPORT_BACKUP_KEY] as StoredPreImportBackup | undefined;
  return isStoredBackup(legacy) ? [legacy] : [];
}

function isStoredBackup(v: unknown): v is StoredPreImportBackup {
  return Boolean(
    v && typeof v === 'object' &&
    typeof (v as StoredPreImportBackup).savedAt === 'string' &&
    (v as StoredPreImportBackup).file
  );
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
    `Badger Hub added badges: ${countBadgerHubAddedBadges(file.local['bloxplus.badgerhub.annotations'])}`,
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

function countBadgerHubAddedBadges(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const games = (value as { games?: unknown }).games;
  if (!games || typeof games !== 'object') return 0;
  return Object.values(games as Record<string, unknown>).reduce<number>((sum, game) => {
    if (!game || typeof game !== 'object') return sum;
    const added = (game as { addedBadges?: unknown }).addedBadges;
    return sum + (Array.isArray(added) ? added.length : 0);
  }, 0);
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

function formatRoProWarnings(warnings: string[]): string {
  if (!warnings.length) return '';
  const shown = warnings.slice(0, 3).join(' ');
  const hidden = warnings.length - 3;
  return ` ${shown}${hidden > 0 ? ` (${hidden} more note${hidden === 1 ? '' : 's'}.)` : ''}`;
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

async function hydrateRoProPlaceEntries(entries: GamePlaytimeEntry[]): Promise<GamePlaytimeEntry[]> {
  const cache = new Map<number, number | null>();
  return Promise.all(entries.map(async (entry) => {
    if (entry.universeId || !entry.placeId) return entry;
    if (!cache.has(entry.placeId)) cache.set(entry.placeId, await placeIdToUniverseId(entry.placeId));
    const universeId = cache.get(entry.placeId);
    return universeId ? { ...entry, universeId } : entry;
  }));
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
      windowSeconds: mergeWindowSeconds(current.windowSeconds, entry.windowSeconds),
      trackingBuckets: mergeTrackingBuckets(current.trackingBuckets, entry.trackingBuckets),
      sources: [...new Set([...(current.sources ?? []), ...(entry.sources ?? [])])],
    });
  }
  return [...byUniverse.values(), ...passthrough];
}

function mergeWindowSeconds(
  current: Record<string, number> | undefined,
  next: Record<string, number> | undefined
): Record<string, number> | undefined {
  const out: Record<string, number> = { ...(current ?? {}) };
  for (const [key, seconds] of Object.entries(next ?? {})) {
    out[key] = Math.max(out[key] ?? 0, seconds);
  }
  return Object.keys(out).length ? out : undefined;
}

function mergeTrackingBuckets(
  current: GamePlaytimeEntry['trackingBuckets'],
  next: GamePlaytimeEntry['trackingBuckets']
): GamePlaytimeEntry['trackingBuckets'] {
  const hours = mergeBucketMap(current?.hours, next?.hours);
  const days = mergeBucketMap(current?.days, next?.days);
  return hours || days ? { hours, days } : undefined;
}

function mergeBucketMap(
  current: Record<string, number> | undefined,
  next: Record<string, number> | undefined
): Record<string, number> | undefined {
  const out: Record<string, number> = { ...(current ?? {}) };
  for (const [key, seconds] of Object.entries(next ?? {})) {
    out[key] = Math.max(out[key] ?? 0, seconds);
  }
  return Object.keys(out).length ? out : undefined;
}

function latestIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return b > a ? b : a;
}

function parseIsoTime(value: string | undefined): number {
  const ts = Date.parse(value ?? '');
  return Number.isFinite(ts) ? ts : 0;
}

const advancedCss = `
  :root { color-scheme: dark; }
  body { margin: 0; background: #111316; color: #f2f4f5; font-family: "Builder Sans", "Source Sans Pro", "Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif; }
  button, input, select, textarea { font: inherit; }
  .adv-page { min-height: 100vh; display: flex; }
  .adv-sidebar { width: 230px; padding: 22px 16px; border-right: 1px solid rgba(255,255,255,0.08); background: #16181d; position: sticky; top: 0; height: 100vh; box-sizing: border-box; }
  .adv-brand { font-size: 19px; font-weight: 800; margin-bottom: 18px; letter-spacing: 0.01em; }
  .adv-nav-button { width: 100%; min-height: 0; display: block; color: rgba(242,244,245,0.72); text-decoration: none; padding: 9px 10px; border-radius: 8px; font-size: 13px; text-align: left; background: transparent; border: 0; font-weight: 600; cursor: pointer; }
  .adv-nav-button:hover { background: rgba(255,255,255,0.07); color: #fff; filter: none; }
  .adv-main { flex: 1; max-width: 1080px; padding: 30px; box-sizing: border-box; }
  .adv-hero { margin-bottom: 18px; }
  .adv-hero p { margin: 0 0 4px; color: #7e9bff; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
  .adv-hero h1 { margin: 0; font-size: 28px; font-weight: 800; letter-spacing: 0.01em; }
  .adv-card { background: #1b1e24; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 18px; margin-bottom: 18px; }
  .adv-card h2 { margin: 0 0 4px; font-size: 18px; font-weight: 700; }
  .adv-card h3 { margin: 0 0 8px; font-size: 14px; font-weight: 700; }
  .adv-card p { margin: 0; color: rgba(242,244,245,0.62); font-size: 13px; line-height: 1.5; }
  .adv-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
  .adv-two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .adv-tool, .adv-preview, .adv-restore, .adv-warning { background: rgba(255,255,255,0.035); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 13px; }
  .adv-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  button, .adv-button-link { min-height: 32px; padding: 0 14px; border-radius: 8px; border: 0; background: #335fff; color: #fff; font-weight: 600; font-size: 13px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; transition: background 0.12s ease; }
  button:hover, .adv-button-link:hover { background: #4b74ff; filter: none; }
  button:disabled { opacity: .45; cursor: default; background: #335fff; }
  .adv-secondary { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14); }
  .adv-secondary:hover { background: rgba(255,255,255,0.14); }
  button.adv-secondary:disabled { background: rgba(255,255,255,0.08); }
  .adv-danger { background: rgba(245,99,92,0.16); border: 1px solid rgba(245,99,92,0.4); color: #ffb1ad; }
  .adv-danger:hover { background: rgba(245,99,92,0.26); }
  button.adv-danger:disabled { background: rgba(245,99,92,0.16); }
  .adv-preview { margin-top: 14px; }
  .adv-preview ul { margin: 8px 0 0; padding-left: 18px; color: rgba(242,244,245,0.80); font-size: 13px; }
  .adv-restore { margin-top: 14px; display: flex; flex-direction: column; gap: 10px; }
  .adv-restore-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .adv-restore-meta { font-size: 11px; color: rgba(242,244,245,0.45); }
  .adv-restore-empty { font-size: 13px; color: rgba(242,244,245,0.50); margin: 0; }
  .adv-restore-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .adv-restore-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 12px; background: rgba(255,255,255,0.035); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; }
  .adv-restore-row-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .adv-restore-row-text strong { font-size: 13px; }
  .adv-restore-row-text span { font-size: 11px; color: rgba(242,244,245,0.50); }
  .adv-restore-row-actions { display: flex; gap: 8px; }
  .adv-status { margin-top: 12px; padding: 10px 12px; border-radius: 8px; font-size: 13px; }
  .adv-status-ok { background: rgba(63,198,121,0.12); border: 1px solid rgba(63,198,121,0.34); color: #b7efc3; }
  .adv-status-err { background: rgba(245,99,92,0.12); border: 1px solid rgba(245,99,92,0.38); color: #ffc0bd; }
  .adv-playtime-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) 180px; gap: 10px; margin-bottom: 12px; }
  input, select { height: 34px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.14); background: #14161a; color: #fff; padding: 0 10px; box-sizing: border-box; color-scheme: dark; }
  input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid rgba(51,95,255,0.55); outline-offset: 1px; }
  select option { background: #14161a; color: #fff; }
  .adv-warning { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: #ffd383; border-color: rgba(255,193,84,0.32); background: rgba(255,193,84,0.08); margin-bottom: 12px; }
  .adv-ropro-export { background: rgba(255,255,255,0.035); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 13px; margin-top: 12px; }
  .adv-ropro-json { width: 100%; min-height: 110px; margin-top: 12px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.14); background: #14161a; color: #fff; padding: 10px; box-sizing: border-box; color-scheme: dark; resize: vertical; font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: 12px; }
  .adv-playtime-editor { display: flex; flex-direction: column; gap: 12px; }
  .adv-playtime-editor label, .adv-grid-three label, .adv-add-time label { display: flex; flex-direction: column; gap: 6px; color: rgba(242,244,245,0.62); font-size: 12px; font-weight: 600; }
  .adv-grid-three { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
  .adv-add-time { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 10px; align-items: end; }
  code { color: #9db4ff; }
  .adv-storage-meters { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 16px; }
  .adv-meter { background: rgba(255,255,255,0.035); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 11px 12px; display: flex; flex-direction: column; gap: 6px; }
  .adv-meter-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: rgba(242,244,245,0.82); }
  .adv-meter-head strong { font-size: 13px; }
  .adv-meter-bar { height: 6px; background: rgba(255,255,255,0.10); border-radius: 999px; overflow: hidden; }
  .adv-meter-fill { height: 100%; transition: width 220ms ease; }
  .adv-meter-fill-ok { background: linear-gradient(90deg, #2bb14c, #58c976); }
  .adv-meter-fill-warn { background: linear-gradient(90deg, #d9a93e, #ffc154); }
  .adv-meter-fill-danger { background: linear-gradient(90deg, #d95d4f, #ff8478); }
  .adv-meter-sub { font-size: 11px; color: rgba(242,244,245,0.45); }
  .adv-storage-section { margin-top: 16px; }
  .adv-storage-section h3 { margin: 0 0 8px; font-size: 14px; color: rgba(242,244,245,0.92); }
  .adv-storage-table { width: 100%; border-collapse: collapse; font-size: 13px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 10px; overflow: hidden; }
  .adv-storage-table th, .adv-storage-table td { padding: 8px 12px; text-align: left; }
  .adv-storage-table thead { background: rgba(255,255,255,0.05); }
  .adv-storage-table th { font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: rgba(242,244,245,0.50); }
  .adv-storage-table tbody tr + tr { border-top: 1px solid rgba(255,255,255,0.05); }
  .adv-storage-table td:last-child { text-align: right; font-variant-numeric: tabular-nums; color: rgba(242,244,245,0.82); white-space: nowrap; }
  .adv-storage-key { display: block; margin-top: 2px; font-size: 11px; color: rgba(157,180,255,0.55); }
  @media (max-width: 820px) {
    .adv-storage-meters { grid-template-columns: 1fr; }
  }
  @media (max-width: 820px) {
    .adv-page { display: block; }
    .adv-sidebar { position: static; width: auto; height: auto; border-right: 0; border-bottom: 1px solid rgba(255,255,255,0.08); }
    .adv-main { padding: 18px; }
    .adv-two, .adv-playtime-toolbar, .adv-grid-three, .adv-add-time { grid-template-columns: 1fr; }
  }
`;
