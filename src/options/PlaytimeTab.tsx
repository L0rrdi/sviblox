import { useEffect, useMemo, useState } from 'react';
import { GamePlaytimeEntry } from '@/types';
import { clearTrackedTime, getPlaytime, setPlaytime } from '@/storage/playtimeStore';
import { parseRoProJson, RoProUnit } from '@/playtime/importRoPro';
import { mergePlaytime } from '@/playtime/normalizePlaytime';

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h >= 1) return `${h.toLocaleString()}h ${m}m`;
  return `${m}m`;
}

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

export function PlaytimeTab() {
  const [entries, setEntries] = useState<GamePlaytimeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [importText, setImportText] = useState('');
  const [importUnit, setImportUnit] = useState<RoProUnit>('minutes');
  const [importMessage, setImportMessage] = useState<string | null>(null);

  useEffect(() => {
    void getPlaytime().then((e) => {
      setEntries(e);
      setLoading(false);
    });
  }, []);

  const sorted = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return [...entries]
      .filter((e) => {
        if (!f) return true;
        return (
          String(e.universeId ?? '').includes(f) ||
          String(e.placeId ?? '').includes(f) ||
          (e.gameName ?? '').toLowerCase().includes(f)
        );
      })
      .sort((a, b) => b.totalSeconds - a.totalSeconds);
  }, [entries, filter]);

  const totalSeconds = useMemo(
    () => entries.reduce((s, e) => s + e.totalSeconds, 0),
    [entries]
  );

  const onExport = () => {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sviblox-playtime-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onResetTracked = async () => {
    if (!confirm('Reset extension-tracked time? Imported time is kept.')) return;
    await clearTrackedTime();
    setEntries(await getPlaytime());
  };

  const onImport = async () => {
    setImportMessage(null);
    try {
      const preview = parseRoProJson(importText, importUnit);
      const merged = mergePlaytime(entries, preview.entries);
      await setPlaytime(merged);
      setEntries(merged);
      setImportText('');
      setImportMessage(
        `Imported ${preview.entries.length} entries (${fmtDuration(preview.totalSeconds)}).` +
          (preview.warnings.length ? ' ' + preview.warnings.join(' ') : '')
      );
    } catch (e) {
      setImportMessage(`Import failed: ${(e as Error).message}`);
    }
  };

  const onFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setImportText(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  if (loading) return <p>Loading…</p>;

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Playtime</h2>
      <p style={{ marginTop: 0 }}>
        <strong>Total:</strong> {fmtDuration(totalSeconds)} across {entries.length} game
        {entries.length === 1 ? '' : 's'}
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button onClick={onExport} disabled={!entries.length}>
          Export JSON
        </button>
        <button onClick={onResetTracked} disabled={!entries.length}>
          Reset tracked time
        </button>
      </div>

      <details style={{ marginBottom: 16 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Import RoPro JSON</summary>
        <div style={{ padding: '8px 0' }}>
          <p style={{ marginTop: 0, fontSize: 13, color: '#555' }}>
            Paste RoPro&rsquo;s <code>mostPlayedUniverseCache</code>, a full RoPro storage dump,
            or an existing SviBlox playtime export. Duplicate entries merge by universeId.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <label>
              Legacy timePlayed unit:&nbsp;
              <select value={importUnit} onChange={(e) => setImportUnit(e.target.value as RoProUnit)}>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="seconds">seconds</option>
              </select>
            </label>
            <input
              type="file"
              accept="application/json,.json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
              }}
            />
          </div>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder='{"mostPlayedUniverseCache":{"windows":{"30":{"data":[{"id":"833209132","time_played":1350}]}}}}'
            rows={6}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
          />
          <div style={{ marginTop: 8 }}>
            <button onClick={onImport} disabled={!importText.trim()}>
              Import
            </button>
            {importMessage && (
              <span style={{ marginLeft: 12, fontSize: 13 }}>{importMessage}</span>
            )}
          </div>
        </div>
      </details>

      <input
        type="search"
        placeholder="Filter by ID or name…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        style={{ width: '100%', padding: 6, marginBottom: 8 }}
      />

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid #ccc' }}>
            <th style={{ padding: '6px 4px' }}>Game</th>
            <th style={{ padding: '6px 4px', textAlign: 'right' }}>Total</th>
            <th style={{ padding: '6px 4px', textAlign: 'right' }}>Imported</th>
            <th style={{ padding: '6px 4px', textAlign: 'right' }}>Tracked</th>
            <th style={{ padding: '6px 4px' }}>Last played</th>
            <th style={{ padding: '6px 4px' }}>Source</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((e) => {
            const id = e.universeId ?? e.placeId;
            const url = e.placeId
              ? `https://www.roblox.com/games/${e.placeId}`
              : e.universeId
              ? `https://www.roblox.com/games/?Keyword=${e.universeId}`
              : null;
            return (
              <tr key={String(id)} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '4px' }}>
                  {url ? (
                    <a href={url} target="_blank" rel="noreferrer">
                      {e.gameName ?? `#${id}`}
                    </a>
                  ) : (
                    e.gameName ?? `#${id}`
                  )}
                </td>
                <td style={{ padding: '4px', textAlign: 'right' }}>{fmtDuration(e.totalSeconds)}</td>
                <td style={{ padding: '4px', textAlign: 'right', color: '#666' }}>
                  {fmtDuration(e.importedSeconds)}
                </td>
                <td style={{ padding: '4px', textAlign: 'right', color: '#666' }}>
                  {fmtDuration(e.trackedSeconds)}
                </td>
                <td style={{ padding: '4px' }}>{fmtDate(e.lastPlayedAt)}</td>
                <td style={{ padding: '4px', color: '#666' }}>{e.sources.join(', ')}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
