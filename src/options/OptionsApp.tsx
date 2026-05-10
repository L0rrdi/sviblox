import { useState } from 'react';
import { PlaytimeTab } from './PlaytimeTab';

type Tab = 'settings' | 'themes' | 'playtime';

export function OptionsApp() {
  const [tab, setTab] = useState<Tab>('settings');
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <nav style={{ width: 200, borderRight: '1px solid #ccc', padding: 16 }}>
        <h2>SviBlox</h2>
        <TabBtn active={tab === 'settings'} onClick={() => setTab('settings')}>Settings</TabBtn>
        <TabBtn active={tab === 'themes'} onClick={() => setTab('themes')}>Themes</TabBtn>
        <TabBtn active={tab === 'playtime'} onClick={() => setTab('playtime')}>Playtime</TabBtn>
      </nav>
      <main style={{ flex: 1, padding: 24 }}>
        {tab === 'settings' && (
          <div>
            <h2 style={{ marginTop: 0 }}>Settings</h2>
            <p>Playtime tracking can be toggled from the popup. Other released features run automatically on Roblox pages.</p>
          </div>
        )}
        {tab === 'themes' && (
          <div>
            <h2 style={{ marginTop: 0 }}>Themes</h2>
            <p>Open Roblox Home and click SviBlox Themes in the left navigation to edit presets, colors, and backgrounds.</p>
          </div>
        )}
        {tab === 'playtime' && <PlaytimeTab />}
      </main>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '8px 12px',
        marginBottom: 4,
        background: active ? '#eef' : 'transparent',
        border: '1px solid transparent',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}
